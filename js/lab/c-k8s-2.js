/* Systems Lab · Kubernetes (part 2): YAML graded by small simulators (NetworkPolicy, RBAC, probes, Ingress, Pod Security,
   kustomize, native sidecars, topology spread) plus tuning, scheduling and judgment scenarios.
   This file loads before c-k8s.js, which registers both parts in order (see the end of each file). */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const MORE = [];
  const X = () => D.lab._k8s; // helpers from c-k8s.js, available at runtime

  /* ---------- shared helpers ---------- */
  const docsOf = (src) => {
    const out = [];
    for (const part of String(src || "").split(/^---\s*$/m)) {
      if (!part.trim()) continue;
      const r = K.yaml(part);
      if (!r.ok) return { err: `YAML error: ${r.err}` };
      if (r.val != null) out.push(r.val);
    }
    return { docs: out };
  };
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  const selMatches = (sel, labels) => {
    if (!isObj(sel)) return false;
    labels = labels || {};
    for (const [k, v] of Object.entries(sel.matchLabels || {})) if (labels[k] !== String(v)) return false;
    for (const e of sel.matchExpressions || []) {
      const v = labels[e.key], vals = (e.values || []).map(String);
      if (e.operator === "In" && !vals.includes(v)) return false;
      if (e.operator === "NotIn" && v !== undefined && vals.includes(v)) return false;
      if (e.operator === "Exists" && v === undefined) return false;
      if (e.operator === "DoesNotExist" && v !== undefined) return false;
    }
    return true;
  };
  const verdictRows = (rows) => K.table(["Check", "Expected", "Result"], rows.map((r) => [r.name, r.want, `<span class="${r.ok ? "win" : "lose"}">${r.got}</span>`]), { compact: true });
  const firstFail = (rows) => rows.find((r) => !r.ok);
  const pick = (R, a) => R.pick(a);
  const lbl = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(",");

  /* ===== NetworkPolicy ===== */
  function npWorld(I) {
    const ns = { shop: { "kubernetes.io/metadata.name": "shop", team: "shop" }, monitoring: { "kubernetes.io/metadata.name": "monitoring" }, "ingress-nginx": { "kubernetes.io/metadata.name": "ingress-nginx" }, data: { "kubernetes.io/metadata.name": "data" }, "kube-system": { "kubernetes.io/metadata.name": "kube-system" } };
    const P = (id, n, labels, ip) => ({ id, ns: n, labels, ip });
    const pods = {
      web: P("web", "shop", { app: "web" }, "10.42.1.10"), api: P("api", "shop", { app: I.api }, "10.42.1.11"), worker: P("worker", "shop", { app: "worker" }, "10.42.1.12"), redis: P("redis", "shop", { app: "redis" }, "10.42.1.13"),
      prometheus: P("prometheus", "monitoring", { app: "prometheus" }, "10.42.2.10"), grafana: P("grafana", "monitoring", { app: "grafana" }, "10.42.2.11"),
      nginx: P("nginx", "ingress-nginx", { "app.kubernetes.io/name": "ingress-nginx" }, "10.42.3.10"),
      postgres: P("postgres", "data", { app: "postgres" }, "10.42.4.10"), apg: P("apg", "data", { app: "analytics-pg" }, "10.42.4.11"),
      dns: P("dns", "kube-system", { "k8s-app": "kube-dns" }, "10.42.5.10"),
      partner: { id: "partner", ext: true, ip: I.partnerIp }, imds: { id: "imds", ext: true, ip: "169.254.169.254" }, internet: { id: "internet", ext: true, ip: "8.8.8.8" },
    };
    return { ns, pods };
  }
  const npName = (W, id) => { const p = W.pods[id]; return p.ext ? p.ip : `${p.ns}/${p.id === "api" ? Object.values(p.labels)[0] : p.id}`; };
  function npTypes(p) { return p.spec.policyTypes || (p.spec.egress ? ["Ingress", "Egress"] : ["Ingress"]); }
  function npPeers(peers, pod, polNs, W) {
    if (!peers || !peers.length) return true;
    return peers.some((peer) => {
      if (!isObj(peer)) return false;
      if (peer.ipBlock) { if (!pod.ip || !peer.ipBlock.cidr) return false; try { return K.inCidr(pod.ip, peer.ipBlock.cidr) && !(peer.ipBlock.except || []).some((c) => K.inCidr(pod.ip, c)); } catch (e) { return false; } }
      if (pod.ext) return false;
      const nsOk = peer.namespaceSelector ? selMatches(peer.namespaceSelector, W.ns[pod.ns]) : pod.ns === polNs;
      const podOk = peer.podSelector ? selMatches(peer.podSelector, pod.labels) : true;
      return nsOk && podOk;
    });
  }
  const npPorts = (ports, f) => !ports || !ports.length || ports.some((p) => (p.protocol || "TCP") === f.proto && (p.port == null || +p.port === f.port || (p.endPort && f.port >= +p.port && f.port <= +p.endPort)));
  function npSide(pols, pod, type, ok) {
    if (pod.ext) return true;
    const sel = pols.filter((p) => p.ns === pod.ns && selMatches(p.spec.podSelector, pod.labels) && npTypes(p).includes(type));
    if (!sel.length) return true;
    const key = type === "Ingress" ? "ingress" : "egress";
    return sel.some((p) => (p.spec[key] || []).some((r) => isObj(r) && ok(r, p)));
  }
  function npEval(I, src) {
    const W = npWorld(I);
    const d = docsOf(src); if (d.err) return { err: d.err };
    const pols = [];
    for (const doc of [...(I.base || []).map((b) => K.yaml(b).val), ...d.docs]) {
      if (!isObj(doc) || doc.kind !== "NetworkPolicy") return { err: `Every document must be a NetworkPolicy (found kind: ${esc(String((doc || {}).kind))}).` };
      if (doc.apiVersion !== "networking.k8s.io/v1") return { err: `apiVersion must be networking.k8s.io/v1 (found ${esc(String(doc.apiVersion))}).` };
      if (!isObj(doc.metadata) || !doc.metadata.name) return { err: "metadata.name is required." };
      if (!isObj(doc.spec) || !isObj(doc.spec.podSelector)) return { err: `NetworkPolicy "${esc(doc.metadata.name)}" is invalid: spec.podSelector: Required value (use {} to select every pod).` };
      pols.push({ ns: doc.metadata.namespace || "shop", spec: doc.spec, name: doc.metadata.name });
    }
    if (pols.some((p) => p.ns !== "shop")) return { err: "Policies in this task belong in the <code>shop</code> namespace." };
    const rows = I.flows.map((f) => {
      const a = W.pods[f.from], b = W.pods[f.to];
      const eg = npSide(pols, a, "Egress", (r, p) => npPeers(r.to, b, p.ns, W) && npPorts(r.ports, f));
      const ing = npSide(pols, b, "Ingress", (r, p) => npPeers(r.from, a, p.ns, W) && npPorts(r.ports, f));
      const got = eg && ing;
      return { name: `${npName(W, f.from)} → ${npName(W, f.to)}:${f.port}/${f.proto}`, want: f.want ? "allowed" : "denied", got: got ? "allowed" : `denied${!eg ? " (egress)" : ""}${!ing ? " (ingress)" : ""}`, ok: got === f.want };
    });
    return { rows, n: d.docs.length };
  }
  const NP_HEAD = (name, app) => `apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: ${name}\n  namespace: shop\nspec:\n  podSelector:\n    matchLabels:\n      app: ${app}\n`;
  MORE.push({
    id: "k8s-networkpolicy", name: "Write the NetworkPolicy", kind: "Hardening", skills: ["design", "safe"], w: "code",
    gen(lv, R) {
      const I = { lv, api: pick(R, ["orders-api", "payments-api", "ledger-api"]), partnerIp: `203.0.113.${R.int(10, 200)}`, metricsPort: pick(R, [9090, 9102, 8081]) };
      const F = (from, to, port, want, proto = "TCP") => ({ from, to, port, proto, want });
      if (lv === 1) I.flows = [F("web", "api", 8080, true), F("worker", "api", 8080, false), F("prometheus", "api", I.metricsPort, true), F("grafana", "api", I.metricsPort, false), F("redis", "api", 8080, false), F("worker", "redis", 6379, true)];
      if (lv === 2) { I.base = [NP_HEAD("default-deny-ingress", "x").replace("    matchLabels:\n      app: x\n", "    {}\n").replace("podSelector:\n    {}", "podSelector: {}") + "  policyTypes:\n  - Ingress\n"]; I.flows = [F("nginx", "web", 8080, true), F("nginx", "api", 8080, false), F("web", "api", 8080, true), F("worker", "api", 8080, false), F("prometheus", "web", I.metricsPort, true), F("prometheus", "api", I.metricsPort, true), F("grafana", "web", I.metricsPort, false), F("grafana", "api", 8080, false), F("worker", "redis", 6379, false)]; }
      if (lv === 3) I.flows = [F("api", "dns", 53, true, "UDP"), F("api", "dns", 53, true), F("api", "postgres", 5432, true), F("api", "apg", 5432, false), F("api", "partner", 443, true), F("api", "imds", 80, false), F("api", "internet", 443, false), F("api", "redis", 6379, false), F("web", "api", 8080, true), F("worker", "redis", 6379, true)];
      return I;
    },
    text: (I) => I.lv === 1 ? `<p>Namespace <code>shop</code> has no NetworkPolicies, so anything can call <b>${esc(I.api)}</b>. Lock it down: only the <code>web</code> pods may call it on port 8080, and Prometheus (namespace <code>monitoring</code>, label <code>app=prometheus</code>) must keep scraping its metrics on port ${I.metricsPort}. Other pods in <code>monitoring</code> (e.g. Grafana) must not. Everything not involving ${esc(I.api)} keeps working.</p><p>Namespaces carry the label <code>kubernetes.io/metadata.name</code>. The checks below run your policy against a matrix of real flows.</p>`
      : I.lv === 2 ? `<p>Security just applied <code>default-deny-ingress</code> (podSelector <code>{}</code>, policyTypes Ingress) to <code>shop</code>, and everything broke. Write the allow policies (several documents separated by <code>---</code> are fine): the ingress controller (namespace <code>ingress-nginx</code>, label <code>app.kubernetes.io/name=ingress-nginx</code>) reaches <code>web</code> on 8080; <code>web</code> reaches <b>${esc(I.api)}</b> on 8080; Prometheus (namespace <code>monitoring</code>, <code>app=prometheus</code>) scrapes every shop pod on ${I.metricsPort}. Nothing else.</p>`
        : `<p>After an SSRF scare, <b>${esc(I.api)}</b> may only open connections to: Postgres (namespace <code>data</code>, <code>app=postgres</code>) on 5432, the payments partner at <code>${I.partnerIp}</code> (in <code>203.0.113.0/24</code>) on 443, and cluster DNS (namespace <code>kube-system</code>, <code>k8s-app=kube-dns</code>). Nothing else: not other databases, not the internet, not the cloud metadata endpoint. Incoming traffic to ${esc(I.api)} must be unaffected.</p>`,
    ui: (I) => ({ lang: "yaml", file: I.lv === 2 ? "allow-shop.yaml" : `${I.api}-netpol.yaml`, rows: 22, starter: I.lv === 2 ? NP_HEAD("allow-ingress-to-web", "web") + "  policyTypes:\n  - Ingress\n  ingress: []\n" : NP_HEAD(I.lv === 3 ? `${I.api}-egress` : `${I.api}-ingress`, I.api) + `  policyTypes:\n  - ${I.lv === 3 ? "Egress" : "Ingress"}\n  ${I.lv === 3 ? "egress" : "ingress"}: []\n`,
      live: (src) => { if (!src || !src.trim()) return ""; const r = npEval(I, src); return r.err ? `<p class="lose small">${r.err}</p>` : verdictRows(r.rows); } }),
    accept(I, src) { const r = npEval(I, src); if (r.err) return r.err; const f = firstFail(r.rows); return f ? `<b>${esc(f.name)}</b> is ${esc(f.got)} but should be ${f.want}.${r.rows.filter((x) => !x.ok).length > 1 ? ` (${r.rows.filter((x) => !x.ok).length} flows wrong.)` : ""}` : true; },
    solve: (I) => I.lv === 1 ? NP_HEAD(`${I.api}-ingress`, I.api) + `  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels:\n          app: web\n    ports:\n    - port: 8080\n  - from:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: monitoring\n      podSelector:\n        matchLabels:\n          app: prometheus\n    ports:\n    - port: ${I.metricsPort}\n`
      : I.lv === 2 ? NP_HEAD("allow-ingress-to-web", "web") + `  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: ingress-nginx\n      podSelector:\n        matchLabels:\n          app.kubernetes.io/name: ingress-nginx\n    ports:\n    - port: 8080\n---\n` + NP_HEAD("allow-web-to-api", I.api) + `  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels:\n          app: web\n    ports:\n    - port: 8080\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow-prometheus\n  namespace: shop\nspec:\n  podSelector: {}\n  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: monitoring\n      podSelector:\n        matchLabels:\n          app: prometheus\n    ports:\n    - port: ${I.metricsPort}\n`
        : NP_HEAD(`${I.api}-egress`, I.api) + `  policyTypes:\n  - Egress\n  egress:\n  - to:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: kube-system\n      podSelector:\n        matchLabels:\n          k8s-app: kube-dns\n    ports:\n    - port: 53\n      protocol: UDP\n    - port: 53\n      protocol: TCP\n  - to:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: data\n      podSelector:\n        matchLabels:\n          app: postgres\n    ports:\n    - port: 5432\n  - to:\n    - ipBlock:\n        cidr: 203.0.113.0/24\n    ports:\n    - port: 443\n`,
    bad: (I) => I.lv === 1 ? [NP_HEAD(`${I.api}-ingress`, I.api) + "  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels:\n          app: web\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: monitoring\n"]
      : I.lv === 2 ? [NP_HEAD("allow-all-from-monitoring", "web").replace("    matchLabels:\n      app: web\n", "    {}\n").replace("podSelector:\n    {}", "podSelector: {}") + "  policyTypes:\n  - Ingress\n  ingress:\n  - from:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: monitoring\n    - podSelector:\n        matchLabels:\n          app: prometheus\n"]
        : [NP_HEAD(`${I.api}-egress`, I.api) + "  policyTypes:\n  - Egress\n  egress:\n  - to:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: data\n    ports:\n    - port: 5432\n  - to:\n    - ipBlock:\n        cidr: 203.0.113.0/24\n", NP_HEAD(`${I.api}-egress`, I.api) + "  policyTypes:\n  - Ingress\n  - Egress\n  egress:\n  - to:\n    - ipBlock:\n        cidr: 0.0.0.0/0\n        except:\n        - 169.254.169.254/32\n"],
    hint: (I) => I.lv === 1 ? "Inside one <code>from</code> entry, namespaceSelector and podSelector are ANDed; as two separate entries they are ORed." : I.lv === 2 ? "Policies are additive: each one you add only allows more. An empty podSelector <code>{}</code> selects every pod in the namespace." : "Once a pod is selected for Egress, everything not allowed is dropped, including DNS lookups. And listing only Egress in policyTypes leaves ingress alone.",
    concept: "NetworkPolicy semantics",
    how: "A pod is isolated for ingress (or egress) as soon as any NetworkPolicy selecting it lists that direction in policyTypes; from then on only traffic matching some rule of some selecting policy is allowed, and policies only ever add allowances. A connection needs the source's egress and the destination's ingress to both allow it. In a peer, <code>namespaceSelector</code> and <code>podSelector</code> in the same list item are ANDed; in separate items they are ORed. A podSelector alone means 'in the policy's own namespace'. Egress lockdowns must explicitly allow DNS (UDP and TCP 53) to the cluster DNS pods.",
    rule: "Start from default deny, add narrow allow rules with ports, put namespace and pod selectors in the same peer when you mean 'that pod in that namespace', and always allow DNS when you restrict egress.",
    why: (I) => I.lv === 1 ? `Selecting ${esc(I.api)} isolated it, so only the listed sources get in: web on 8080, and Prometheus on ${I.metricsPort} through a single peer that ANDs the monitoring namespace with app=prometheus. Splitting that peer in two would have let Grafana and every web pod scrape metrics.`
      : I.lv === 2 ? "With default deny in place every hop needs its own allowance: ingress-nginx to web, web to the API, and Prometheus to every pod on the metrics port (podSelector {} with an ANDed namespace+pod peer)."
        : "Egress isolation also blocks DNS, so name lookups fail before any connection is attempted. The policy allows kube-dns on 53/UDP and 53/TCP, Postgres by namespace AND label (not every database in <code>data</code>), and the partner CIDR on 443; metadata and the internet are denied because nothing allows them. Listing only Egress in policyTypes keeps ingress untouched.",
  });

  /* ===== RBAC ===== */
  function rbacEval(I, src) {
    const d = docsOf(src); if (d.err) return { err: d.err };
    const rules = [];
    for (const doc of d.docs) {
      if (!isObj(doc)) return { err: "Each document must be a Role." };
      if (doc.kind === "RoleBinding" || doc.kind === "ServiceAccount") continue;
      if (doc.kind === "ClusterRole") return { err: "A ClusterRole is cluster-wide by nature; this access is for one namespace, so write a Role." };
      if (doc.kind !== "Role") return { err: `Unexpected kind ${esc(String(doc.kind))}.` };
      if (doc.apiVersion !== "rbac.authorization.k8s.io/v1") return { err: "apiVersion must be rbac.authorization.k8s.io/v1." };
      for (const r of doc.rules || []) {
        if (!isObj(r) || !Array.isArray(r.verbs) || !Array.isArray(r.resources) || !Array.isArray(r.apiGroups)) return { err: `Role "${esc((doc.metadata || {}).name || "?")}" is invalid: every rule needs apiGroups, resources and verbs lists.` };
        rules.push(r);
      }
    }
    if (!rules.length) return { err: "Write a Role with at least one rule." };
    const allows = (q) => rules.some((r) => {
      const res = q.sub ? `${q.res}/${q.sub}` : q.res;
      const g = r.apiGroups.map(String).some((x) => x === "*" || x === q.group);
      const rs = r.resources.map(String).some((x) => x === "*" || x === res || (q.sub && (x === `${q.res}/*` || x === `*/${q.sub}`)));
      const v = r.verbs.map(String).some((x) => x === "*" || x === q.verb);
      const n = !r.resourceNames || !r.resourceNames.length || (q.name != null && r.resourceNames.map(String).includes(q.name));
      return g && rs && v && n;
    });
    const rows = I.reqs.map((q) => { const got = allows(q); return { name: `${q.verb} ${q.res}${q.group ? "." + q.group : ""}${q.sub ? "/" + q.sub : ""}${q.name ? ` "${q.name}"` : ""}`, want: q.want ? "allowed" : "forbidden", got: got ? "allowed" : "forbidden", ok: got === q.want }; });
    return { rows };
  }
  MORE.push({
    id: "k8s-rbac-role", name: "Least-privilege Role", kind: "Hardening", skills: ["design", "safe"], w: "code",
    gen(lv, R) {
      const Q = (verb, res, want, o = {}) => ({ verb, res, want, group: o.g || "", sub: o.sub, name: o.name });
      const I = { lv, ns: pick(R, ["shop", "payments", "search"]) };
      if (lv === 1) { I.who = "ci-deployer"; I.reqs = [Q("get", "deployments", true, { g: "apps" }), Q("list", "deployments", true, { g: "apps" }), Q("watch", "deployments", true, { g: "apps" }), Q("patch", "deployments", true, { g: "apps" }), Q("list", "pods", true), Q("get", "pods", true), Q("delete", "deployments", false, { g: "apps" }), Q("get", "secrets", false), Q("create", "pods", false, { sub: "exec" })]; }
      if (lv === 2) { I.who = "oncall-debugger"; I.reqs = [Q("list", "pods", true), Q("get", "pods", true), Q("get", "pods", true, { sub: "log" }), Q("list", "events", true), Q("patch", "deployments", true, { g: "apps", sub: "scale" }), Q("get", "deployments", true, { g: "apps" }), Q("create", "pods", false, { sub: "exec" }), Q("create", "pods", false, { sub: "portforward" }), Q("get", "secrets", false), Q("patch", "deployments", false, { g: "apps" }), Q("delete", "pods", false)]; }
      if (lv === 3) { I.who = "flag-operator"; I.cm = pick(R, ["feature-flags", "flags", "rollout-flags"]); I.lease = "flag-operator-leader"; I.reqs = [Q("get", "configmaps", true, { name: I.cm }), Q("update", "configmaps", true, { name: I.cm }), Q("patch", "configmaps", true, { name: I.cm }), Q("get", "configmaps", false, { name: "app-config" }), Q("patch", "configmaps", false, { name: "app-config" }), Q("list", "configmaps", false), Q("create", "leases", true, { g: "coordination.k8s.io" }), Q("get", "leases", true, { g: "coordination.k8s.io", name: I.lease }), Q("update", "leases", true, { g: "coordination.k8s.io", name: I.lease }), Q("update", "leases", false, { g: "coordination.k8s.io", name: "other-controller" }), Q("create", "events", true), Q("get", "secrets", false)]; }
      return I;
    },
    text: (I) => {
      const list = (w) => I.reqs.filter((q) => q.want === w).map((q) => `<code>${q.verb} ${q.res}${q.sub ? "/" + q.sub : ""}${q.name ? " " + q.name : ""}</code>`).join(", ");
      return `<p>Write the namespaced <b>Role</b> for the <code>${I.who}</code> ServiceAccount in <code>${esc(I.ns)}</code> (the RoleBinding already exists). It must allow ${list(true)}, and nothing more: in particular ${list(false)} must be forbidden.${I.lv === 3 ? " The operator's leader election creates its Lease the first time it starts." : ""}</p><p>Every request in the table is evaluated against your rules the way the RBAC authorizer does.</p>`;
    },
    ui: (I) => ({ lang: "yaml", file: `${I.who}-role.yaml`, rows: 20, starter: `apiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nmetadata:\n  name: ${I.who}\n  namespace: ${I.ns}\nrules:\n- apiGroups: [""]\n  resources: []\n  verbs: []\n`, live: (src) => { if (!src || !src.trim()) return ""; const r = rbacEval(I, src); return r.err ? `<p class="lose small">${r.err}</p>` : verdictRows(r.rows); } }),
    accept(I, src) { const r = rbacEval(I, src); if (r.err) return r.err; const f = firstFail(r.rows); return f ? `<b>${esc(f.name)}</b> is ${f.got} but should be ${f.want}.` : true; },
    solve: (I) => {
      const head = `apiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nmetadata:\n  name: ${I.who}\n  namespace: ${I.ns}\nrules:\n`;
      if (I.lv === 1) return head + `- apiGroups: ["apps"]\n  resources: ["deployments"]\n  verbs: ["get", "list", "watch", "patch"]\n- apiGroups: [""]\n  resources: ["pods"]\n  verbs: ["get", "list"]\n`;
      if (I.lv === 2) return head + `- apiGroups: [""]\n  resources: ["pods", "pods/log", "events"]\n  verbs: ["get", "list"]\n- apiGroups: ["apps"]\n  resources: ["deployments"]\n  verbs: ["get"]\n- apiGroups: ["apps"]\n  resources: ["deployments/scale"]\n  verbs: ["patch"]\n`;
      return head + `- apiGroups: [""]\n  resources: ["configmaps"]\n  resourceNames: ["${I.cm}"]\n  verbs: ["get", "update", "patch"]\n- apiGroups: ["coordination.k8s.io"]\n  resources: ["leases"]\n  verbs: ["create"]\n- apiGroups: ["coordination.k8s.io"]\n  resources: ["leases"]\n  resourceNames: ["${I.lease}"]\n  verbs: ["get", "update"]\n- apiGroups: [""]\n  resources: ["events"]\n  verbs: ["create"]\n`;
    },
    bad: (I) => {
      const head = `apiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nmetadata:\n  name: ${I.who}\n  namespace: ${I.ns}\nrules:\n`;
      if (I.lv === 1) return [head + `- apiGroups: ["apps"]\n  resources: ["deployments"]\n  verbs: ["*"]\n- apiGroups: [""]\n  resources: ["pods"]\n  verbs: ["get", "list"]\n`, head + `- apiGroups: [""]\n  resources: ["deployments", "pods"]\n  verbs: ["get", "list", "watch", "patch"]\n`];
      if (I.lv === 2) return [head + `- apiGroups: [""]\n  resources: ["pods", "pods/*", "events"]\n  verbs: ["get", "list", "create"]\n- apiGroups: ["apps"]\n  resources: ["deployments", "deployments/scale"]\n  verbs: ["get", "patch"]\n`];
      return [head + `- apiGroups: [""]\n  resources: ["configmaps"]\n  resourceNames: ["${I.cm}"]\n  verbs: ["get", "update", "patch"]\n- apiGroups: ["coordination.k8s.io"]\n  resources: ["leases"]\n  resourceNames: ["${I.lease}"]\n  verbs: ["get", "update", "create"]\n- apiGroups: [""]\n  resources: ["events"]\n  verbs: ["create"]\n`, head + `- apiGroups: [""]\n  resources: ["configmaps", "events"]\n  verbs: ["get", "update", "patch", "create"]\n- apiGroups: ["coordination.k8s.io"]\n  resources: ["leases"]\n  verbs: ["get", "update", "create"]\n`];
    },
    hint: (I) => I.lv === 1 ? "Deployments live in the <code>apps</code> API group; pods in the core group <code>\"\"</code>." : I.lv === 2 ? "Subresources such as pods/log, pods/exec and deployments/scale are authorized separately. A wildcard like pods/* grants exec too." : "resourceNames can't restrict create (the object has no name yet) or list.",
    concept: "RBAC rules, subresources and resourceNames",
    how: "RBAC is allow-only: a request (verb, API group, resource, optional subresource, optional name) is permitted if any rule in any bound role matches all of its parts. Subresources such as <code>pods/log</code>, <code>pods/exec</code> or <code>deployments/scale</code> are separate resources, so granting <code>pods</code> doesn't grant exec, while <code>pods/*</code> or <code>*</code> does. <code>resourceNames</code> narrows a rule to named objects, but create requests carry no name and list requests cover many objects, so those verbs need their own rule without resourceNames.",
    rule: "Enumerate the exact API calls the workload makes, grant those verbs on those resources (and subresources), avoid wildcards, and pin update/patch to resourceNames where you can.",
    why: (I) => I.lv === 1 ? "The deployer needs read and patch on deployments in the apps group plus get/list on pods; no wildcard verbs, so delete stays forbidden and secrets and exec are never mentioned."
      : I.lv === 2 ? "Logs come from the pods/log subresource and scaling from deployments/scale, each granted explicitly; exec and port-forward are other pod subresources and stay denied because nothing names them."
        : `Pinning configmaps to resourceNames ["${esc(I.cm)}"] keeps other ConfigMaps out of reach. Lease creation needs a separate rule without resourceNames (a create has no name to match), while get/update stay pinned to ${esc(I.lease)}.`,
  });

  /* ===== Probes ===== */
  function probeOf(p) {
    if (p == null) return null;
    if (!isObj(p)) return { err: "probe must be a map" };
    const h = p.httpGet || {}, port = h.port != null ? h.port : (p.tcpSocket || {}).port;
    return { path: p.httpGet ? h.path || "/" : null, tcp: !!p.tcpSocket, port, d: +(p.initialDelaySeconds || 0), per: +(p.periodSeconds || 10), to: +(p.timeoutSeconds || 1), f: +(p.failureThreshold || 3), s: +(p.successThreshold || 1) };
  }
  function probeSim(I, src) {
    const r = K.yaml(src || "");
    if (!r.ok) return { err: `YAML error: ${esc(r.err)}` };
    const v = r.val || {};
    if (!isObj(v)) return { err: "Expected a map with livenessProbe / readinessProbe / startupProbe." };
    const extra = Object.keys(v).filter((k) => !["livenessProbe", "readinessProbe", "startupProbe"].includes(k));
    if (extra.length) return { err: `Only livenessProbe, readinessProbe and startupProbe belong here (found ${esc(extra.join(", "))}).` };
    const L = probeOf(v.livenessProbe), Rd = probeOf(v.readinessProbe), S = probeOf(v.startupProbe);
    for (const [n, p] of [["livenessProbe", L], ["readinessProbe", Rd], ["startupProbe", S]]) {
      if (!p) continue;
      if (p.err) return { err: `${n}: ${p.err}` };
      if (!p.path && !p.tcp) return { err: `${n} needs an httpGet (path and port) handler.` };
      if (p.path && !["/healthz", "/ready"].includes(p.path)) return { err: `${n}: the app serves /healthz and /ready only; ${esc(p.path)} returns 404.` };
      if (+p.port !== 8080 && p.port !== "http") return { err: `${n}: the app listens on 8080 (port name "http").` };
      if (p.per < 1 || p.to < 1 || p.f < 1) return { err: `${n}: periodSeconds, timeoutSeconds and failureThreshold must be at least 1.` };
      if (n !== "readinessProbe" && p.s !== 1) return { err: `${n}: successThreshold must be 1 for liveness and startup probes.` };
    }
    const rows = [];
    // 1. slowest boot: the container must not be killed before it can answer
    const gate = S || L;
    const surv = !gate || gate.d + (gate.f - 1) * gate.per >= I.bootMax;
    rows.push({ name: `Slowest cold start (${I.bootMax}s)`, want: "no restart", got: surv ? "starts fine" : `killed after ~${gate.d + gate.f * gate.per}s (${S ? "startupProbe" : "liveness"} gave up)`, ok: surv });
    // 2. no traffic before warm-up
    const rdOk = Rd && Rd.path === "/ready";
    rows.push({ name: "No traffic before caches and DB pool are warm", want: "readiness on /ready", got: !Rd ? "no readiness probe: Ready at once" : Rd.path !== "/ready" ? "readiness on /healthz: Ready before warm-up" : "Ready only when /ready passes", ok: rdOk });
    // 3. database outage
    const livDep = L && L.path === "/ready" && L.f * L.per < I.outage;
    rows.push({ name: `${I.outage}s database outage`, want: "no restarts", got: !L ? "no liveness probe" : L.path === "/ready" ? (livDep ? "every pod restarted (liveness checks the DB)" : "survived by luck: liveness still checks the DB") : "no restarts", ok: !!L ? L.path !== "/ready" : true });
    // 4. deadlock after boot
    const detect = L ? L.f * L.per + L.to : Infinity;
    rows.push({ name: "Deadlocked process", want: `restarted within ${I.budget}s`, got: !L ? "never restarted (no liveness probe)" : L.path !== "/healthz" ? "detected only via /ready" : `restarted after ~${detect}s`, ok: !!L && L.path === "/healthz" && detect <= I.budget });
    if (I.gc) {
      const spurious = (p) => p && p.to <= I.gc && p.f < 2;
      rows.push({ name: `${I.gc}s GC pauses (about once a minute)`, want: "no restarts, no endpoint flapping", got: spurious(L) ? "liveness restarts the pod" : spurious(Rd) ? "pod flaps out of the Service" : "absorbed", ok: !spurious(L) && !spurious(Rd) });
    }
    if (I.lv >= 2) {
      const hang = gate ? gate.d + gate.f * gate.per : Infinity;
      rows.push({ name: "Hang during startup", want: `detected within ${I.bootMax + I.budget}s`, got: Number.isFinite(hang) ? `restarted after ~${hang}s` : "never", ok: hang <= I.bootMax + I.budget });
    }
    return { rows };
  }
  MORE.push({
    id: "k8s-probes", name: "Get the probes right", kind: "Config change", skills: ["design", "tune"], w: "code",
    gen(lv, R) {
      const I = { lv, app: pick(R, ["orders", "catalog", "pricing", "ledger"]), outage: R.int(4, 9) * 15, budget: pick(R, [30, 45, 60]) };
      I.bootMax = lv === 1 ? R.int(4, 8) : R.int(9, 16) * 10;
      I.bootTyp = lv === 1 ? 3 : Math.round(I.bootMax * 0.4);
      if (lv === 3) I.gc = pick(R, [2, 3]);
      return I;
    },
    text: (I) => `<p>The <b>${esc(I.app)}</b> container (port 8080) serves <code>/healthz</code> (200 while the process is responsive) and <code>/ready</code> (200 once caches are warm and the DB pool is connected; 503 while the database is unreachable). ${I.lv === 1 ? "Its probes were copied from another service and every database blip restarts all pods at once." : `It boots in ${I.bootTyp}s typically but up to <b>${I.bootMax}s</b> on a cold node.`}${I.gc ? ` The JVM has stop-the-world GC pauses of up to <b>${I.gc}s</b>.` : ""}</p><p>Write the probe section so that: cold starts aren't killed, no traffic arrives before warm-up, a ${I.outage}s database outage restarts nothing, and a deadlocked process is restarted within <b>${I.budget}s</b>${I.lv >= 2 ? " (also during startup, within the boot time plus that budget)" : ""}.</p>`,
    ui: (I) => ({ lang: "yaml", file: `${I.app}-probes.yaml (container fields)`, rows: 18, starter: I.lv === 1 ? "livenessProbe:\n  httpGet:\n    path: /ready\n    port: 8080\n  periodSeconds: 5\n  failureThreshold: 2\n" : "livenessProbe:\n  httpGet:\n    path: /healthz\n    port: 8080\n  periodSeconds: 10\n  failureThreshold: 3\nreadinessProbe:\n  httpGet:\n    path: /ready\n    port: 8080\n  periodSeconds: 5\n", live: (src) => { if (!src || !src.trim()) return ""; const r = probeSim(I, src); return r.err ? `<p class="lose small">${r.err}</p>` : verdictRows(r.rows); } }),
    accept(I, src) { const r = probeSim(I, src); if (r.err) return r.err; const f = firstFail(r.rows); return f ? `<b>${esc(f.name)}</b>: ${esc(f.got)} (want ${esc(f.want)}).` : true; },
    solve: (I) => {
      const per = 10, f = Math.max(1, Math.floor((I.budget - (I.gc ? 4 : 1)) / per));
      const live = `livenessProbe:\n  httpGet:\n    path: /healthz\n    port: 8080\n  periodSeconds: ${per}\n  timeoutSeconds: ${I.gc ? I.gc + 2 : 1}\n  failureThreshold: ${Math.max(f, I.gc ? 2 : 1)}\n`;
      const ready = `readinessProbe:\n  httpGet:\n    path: /ready\n    port: 8080\n  periodSeconds: 5\n  timeoutSeconds: ${I.gc ? I.gc + 2 : 1}\n  failureThreshold: ${I.gc ? 2 : 3}\n`;
      const startup = I.lv === 1 ? "" : `startupProbe:\n  httpGet:\n    path: /healthz\n    port: 8080\n  periodSeconds: 5\n  failureThreshold: ${Math.ceil(I.bootMax / 5) + 1}\n`;
      return live + ready + startup;
    },
    bad: (I) => [
      "livenessProbe:\n  httpGet:\n    path: /ready\n    port: 8080\n  periodSeconds: 10\n  failureThreshold: 3\nreadinessProbe:\n  httpGet:\n    path: /ready\n    port: 8080\n" + (I.lv > 1 ? `startupProbe:\n  httpGet:\n    path: /healthz\n    port: 8080\n  periodSeconds: 10\n  failureThreshold: ${Math.ceil(I.bootMax / 10) + 1}\n` : ""),
      "livenessProbe:\n  httpGet:\n    path: /healthz\n    port: 8080\n  periodSeconds: 10\n  failureThreshold: 2\nreadinessProbe:\n  httpGet:\n    path: /healthz\n    port: 8080\n",
      ...(I.lv > 1 ? ["livenessProbe:\n  httpGet:\n    path: /healthz\n    port: 8080\n  periodSeconds: 10\n  failureThreshold: 2\nreadinessProbe:\n  httpGet:\n    path: /ready\n    port: 8080\n"] : []),
    ],
    hint: (I) => I.lv === 1 ? "Liveness answers 'should this container be killed?'. Would restarting the app fix a database outage?" : I.lv === 2 ? "A startupProbe holds off liveness until the app has started once, so liveness itself can stay fast." : "A probe fails when it doesn't answer within timeoutSeconds. How many consecutive failures does one GC pause cause?",
    concept: "Liveness, readiness and startup probes",
    how: "Readiness decides whether a pod receives Service traffic; failing it just removes the pod from endpoints. Liveness decides whether the kubelet kills and restarts the container after failureThreshold consecutive failures, so it must only check things a restart can fix (the process itself), never shared dependencies, or a database blip restarts every pod at once. A startupProbe runs first and disables the other two until it succeeds, giving slow starters up to failureThreshold × periodSeconds without making liveness slow. Each probe fails if it doesn't answer within timeoutSeconds (default 1s).",
    rule: "Liveness: cheap /healthz, tolerant thresholds, no dependency checks. Readiness: 'can I serve right now?'. Startup: sized for the slowest boot.",
    why: (I, sol) => `A liveness probe on /healthz survives the ${I.outage}s database outage and catches a deadlock in about ${(() => { const r = probeSim(I, sol).rows; return r[3] ? esc(r[3].got.replace("restarted after ", "")) : ""; })()}; readiness on /ready keeps traffic away until warm-up.${I.lv > 1 ? ` A startupProbe allowing ${I.bootMax}s+ covers cold starts while liveness stays quick to act afterwards (a liveness initialDelaySeconds sized for the worst boot also works, but a startupProbe states the intent and adapts to fast boots).` : ""}${I.gc ? ` Timeouts above ${I.gc}s (or failureThreshold ≥ 2) absorb GC pauses.` : ""}`,
  });

  /* ===== Ingress ===== */
  function ingEval(I, src) {
    const r = K.yaml(src || ""); if (!r.ok) return { err: `YAML error: ${esc(r.err)}` };
    const ing = r.val;
    if (!isObj(ing) || ing.kind !== "Ingress" || ing.apiVersion !== "networking.k8s.io/v1") return { err: "Write a networking.k8s.io/v1 Ingress." };
    const spec = ing.spec || {};
    const rules = (spec.rules || []).map((x) => ({ host: x.host || null, paths: (((x.http || {}).paths) || []) }));
    for (const ru of rules) for (const p of ru.paths) {
      if (!p.pathType) return { err: `Ingress is invalid: spec.rules[].http.paths[].pathType: Required value (path ${esc(String(p.path))}).` };
      if (!["Exact", "Prefix", "ImplementationSpecific"].includes(p.pathType)) return { err: `pathType "${esc(p.pathType)}" is not one of Exact, Prefix, ImplementationSpecific.` };
      if (!p.path || p.path[0] !== "/") return { err: `paths must start with "/" (found ${esc(String(p.path))}).` };
      const svc = ((p.backend || {}).service) || {};
      if (!svc.name || !(svc.port && (svc.port.number || svc.port.name))) return { err: `path ${esc(p.path)}: backend.service needs a name and port.number.` };
      if (!I.svcs.includes(svc.name)) return { err: `backend service "${esc(svc.name)}" doesn't exist (services: ${I.svcs.join(", ")}).` };
    }
    const hostOk = (h, q) => h == null || h === q || (h.startsWith("*.") && q.endsWith(h.slice(1)) && q.split(".").length === h.split(".").length);
    const route = (q) => {
      const cand = rules.filter((x) => hostOk(x.host, q.host));
      const exactHost = cand.filter((x) => x.host === q.host), wild = cand.filter((x) => x.host && x.host !== q.host), any = cand.filter((x) => !x.host);
      for (const grp of [exactHost, wild, any]) {
        let best = null;
        for (const ru of grp) for (const p of ru.paths) {
          const pp = p.path, typ = p.pathType;
          let m = false;
          if (typ === "Exact") m = q.path === pp;
          else { const a = pp.replace(/\/+$/, "").split("/"), b = q.path.replace(/\/+$/, "").split("/"); m = pp === "/" || (a.length <= b.length && a.every((x, i) => x === b[i])); }
          if (m) { const score = pp.length * 2 + (typ === "Exact" ? 1 : 0); if (!best || score > best.score) best = { score, svc: p.backend.service.name }; }
        }
        if (best) return best.svc;
      }
      return spec.defaultBackend && spec.defaultBackend.service ? spec.defaultBackend.service.name : "404";
    };
    const rows = I.reqs.map((q) => { const got = route(q); return { name: `https://${q.host}${q.path}`, want: q.want === "404" ? "404 (no backend)" : q.want, got: got === "404" ? "404 (no backend)" : got, ok: got === q.want }; });
    return { rows };
  }
  MORE.push({
    id: "k8s-ingress-rules", name: "Route the Ingress", kind: "Config change", skills: ["design"], w: "code",
    gen(lv, R) {
      const d = pick(R, ["shop.example", "store.example", "market.example"]) + ".com";
      const Q = (host, path, want) => ({ host, path, want });
      const I = { lv, d };
      if (lv === 1) { I.svcs = ["web", "api"]; I.reqs = [Q(`www.${d}`, "/", "web"), Q(`www.${d}`, "/cart", "web"), Q(`www.${d}`, "/api", "api"), Q(`www.${d}`, "/api/orders/42", "api"), Q(`www.${d}`, "/apidocs", "web"), Q(`admin.${d}`, "/", "404")]; }
      if (lv === 2) { I.svcs = ["web", "api", "api-v2", "admin", "static"]; I.reqs = [Q(`www.${d}`, "/", "web"), Q(`www.${d}`, "/api/orders", "api"), Q(`www.${d}`, "/api/v2/orders", "api-v2"), Q(`www.${d}`, "/api/v20", "api"), Q(`www.${d}`, "/robots.txt", "static"), Q(`www.${d}`, "/robots.txt.bak", "web"), Q(`admin.${d}`, "/", "admin"), Q(`admin.${d}`, "/api/orders", "admin")]; }
      if (lv === 3) { I.svcs = ["storefront", "api", "web", "not-found"]; I.reqs = [Q(`acme.shops.${d}`, "/", "storefront"), Q(`bolt.shops.${d}`, "/p/123", "storefront"), Q(`api.shops.${d}`, "/v1/products", "api"), Q(`a.b.shops.${d}`, "/", "not-found"), Q(`www.${d}`, "/", "web"), Q(`unknown.${d}`, "/", "not-found"), Q(`acme.shops.${d}`, "/api", "storefront")]; }
      return I;
    },
    text: (I) => I.lv === 1 ? `<p>Write the Ingress for <code>www.${I.d}</code>: everything under <code>/api</code> goes to Service <b>api</b> (port 8080), everything else to <b>web</b> (port 80). Other hosts get nothing (404). Note <code>/apidocs</code> is a web page.</p>`
      : I.lv === 2 ? `<p>Extend routing for <code>www.${I.d}</code>: <code>/api</code> → <b>api</b>, but <code>/api/v2</code> and below → <b>api-v2</b>; exactly <code>/robots.txt</code> → <b>static</b>; everything else → <b>web</b>. The host <code>admin.${I.d}</code> sends all paths to <b>admin</b>. All services listen on port 80.</p>`
        : `<p>Multi-tenant shops: every <code>&lt;tenant&gt;.shops.${I.d}</code> goes to <b>storefront</b>, except <code>api.shops.${I.d}</code>, which goes to <b>api</b>. <code>www.${I.d}</code> goes to <b>web</b>. Any request matching no rule (including deeper names like <code>a.b.shops.${I.d}</code>) must reach <b>not-found</b> instead of the controller's bare 404. All services listen on port 80.</p>`,
    ui: (I) => ({ lang: "yaml", file: "ingress.yaml", rows: 22, starter: `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: shop\nspec:\n  ingressClassName: nginx\n  rules:\n  - host: www.${I.d}\n    http:\n      paths:\n      - path: /\n        pathType: Prefix\n        backend:\n          service:\n            name: ${I.lv === 3 ? "web" : "web"}\n            port:\n              number: 80\n`, live: (src) => { if (!src || !src.trim()) return ""; const r = ingEval(I, src); return r.err ? `<p class="lose small">${r.err}</p>` : verdictRows(r.rows); } }),
    accept(I, src) { const r = ingEval(I, src); if (r.err) return r.err; const f = firstFail(r.rows); return f ? `<b>${esc(f.name)}</b> goes to ${esc(f.got)}, should go to ${esc(f.want)}.` : true; },
    solve: (I) => {
      const be = (svc, port = 80) => `        backend:\n          service:\n            name: ${svc}\n            port:\n              number: ${port}\n`;
      const p = (path, type, svc, port) => `      - path: ${path}\n        pathType: ${type}\n` + be(svc, port);
      const head = `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: shop\nspec:\n  ingressClassName: nginx\n`;
      if (I.lv === 1) return head + `  rules:\n  - host: www.${I.d}\n    http:\n      paths:\n` + p("/api", "Prefix", "api", 8080) + p("/", "Prefix", "web");
      if (I.lv === 2) return head + `  rules:\n  - host: www.${I.d}\n    http:\n      paths:\n` + p("/api/v2", "Prefix", "api-v2") + p("/api", "Prefix", "api") + p("/robots.txt", "Exact", "static") + p("/", "Prefix", "web") + `  - host: admin.${I.d}\n    http:\n      paths:\n` + p("/", "Prefix", "admin");
      return head + `  defaultBackend:\n    service:\n      name: not-found\n      port:\n        number: 80\n  rules:\n  - host: api.shops.${I.d}\n    http:\n      paths:\n` + p("/", "Prefix", "api") + `  - host: "*.shops.${I.d}"\n    http:\n      paths:\n` + p("/", "Prefix", "storefront") + `  - host: www.${I.d}\n    http:\n      paths:\n` + p("/", "Prefix", "web");
    },
    bad: (I) => {
      const s = MORE.find((x) => x.id === "k8s-ingress-rules").solve(I);
      if (I.lv === 1) return [s.replace("path: /api\n        pathType: Prefix", "path: /api\n        pathType: Exact")];
      if (I.lv === 2) return [s.replace("path: /robots.txt\n        pathType: Exact", "path: /robots.txt\n        pathType: Prefix").replace(/      - path: \/api\/v2\n[\s\S]*?number: 80\n/, "")];
      return [s.replace(/  defaultBackend:\n[\s\S]*?number: 80\n/, ""), s.replace(`"*.shops.${I.d}"`, `"*.${I.d}"`)];
    },
    hint: (I) => I.lv === 1 ? "Prefix matching works on whole path segments: /api matches /api/orders but not /apidocs." : I.lv === 2 ? "When several paths match, the longest one wins, and Exact beats Prefix." : "An exact host beats a wildcard, and a wildcard covers exactly one DNS label. What answers when no rule matches?",
    concept: "Ingress host and path matching",
    how: "An Ingress rule matches on host first: an exact host beats a wildcard like <code>*.shops.example.com</code>, which matches exactly one extra DNS label; a rule without host matches everything. Within the matching rule, <code>Exact</code> paths match one string, <code>Prefix</code> paths match element by element split on '/', so /api matches /api and /api/x but not /apidocs. If several paths match, the longest wins, Exact before Prefix. Requests matching no rule go to <code>spec.defaultBackend</code>, or the controller's own 404. ImplementationSpecific leaves matching to the controller.",
    rule: "Use Prefix and Exact (not ImplementationSpecific regexes), lean on longest-match rather than ordering, and set a defaultBackend you control.",
    why: (I) => I.lv === 1 ? "A Prefix path <code>/api</code> takes /api and /api/orders/42, while /apidocs fails the segment match and falls through to /, so it lands on web."
      : I.lv === 2 ? "/api/v2 is longer than /api, so it wins for /api/v2/orders, while /api/v20 isn't a segment match and stays on api. Exact /robots.txt catches only that file; /robots.txt.bak falls to web."
        : `The exact host api.shops.${esc(I.d)} beats the wildcard, the wildcard catches tenants (one label only, so a.b.shops misses), and a defaultBackend sends everything unmatched to not-found.`,
  });


  /* ===== Pod Security Admission ===== */
  const BASE_CAPS = ["AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "MKNOD", "NET_BIND_SERVICE", "SETFCAP", "SETGID", "SETPCAP", "SETUID", "SYS_CHROOT"];
  const OK_VOLS = ["configMap", "csi", "downwardAPI", "emptyDir", "ephemeral", "persistentVolumeClaim", "projected", "secret"];
  function pssCheck(spec) {
    const all = [...(spec.initContainers || []), ...(spec.containers || [])], psc = spec.securityContext || {}, out = [];
    const grp = (list, f) => { const n = list.map((c) => `"${c.name}"`); return n.length ? f(n.length > 1 ? `containers ${n.join(", ")}` : `container ${n[0]}`, n.length > 1) : null; };
    const sc = (c) => c.securityContext || {};
    const hn = ["hostNetwork", "hostPID", "hostIPC"].filter((k) => spec[k] === true);
    if (hn.length) out.push(`host namespaces (${hn.map((k) => k + "=true").join(", ")})`);
    let x = grp(all.filter((c) => sc(c).privileged === true), (w, m) => `privileged (${w} must not set securityContext.privileged=true)`); if (x) out.push(x);
    const badCap = all.filter((c) => ((sc(c).capabilities || {}).add || []).some((k) => !BASE_CAPS.includes(String(k))));
    x = grp(badCap, (w) => `non-default capabilities (${w} must not include ${[...new Set(badCap.flatMap((c) => sc(c).capabilities.add.filter((k) => !BASE_CAPS.includes(String(k)))))].map((k) => `"${k}"`).join(", ")} in securityContext.capabilities.add)`); if (x) out.push(x);
    const hp = (spec.volumes || []).filter((v) => v.hostPath); if (hp.length) out.push(`hostPath volumes (${hp.map((v) => `volume "${v.name}"`).join(", ")})`);
    x = grp(all.filter((c) => (c.ports || []).some((p) => p.hostPort)), (w) => `hostPort (${w} uses hostPort)`); if (x) out.push(x);
    x = grp(all.filter((c) => sc(c).allowPrivilegeEscalation !== false), (w, m) => `allowPrivilegeEscalation != false (${w} must set securityContext.allowPrivilegeEscalation=false)`); if (x) out.push(x);
    x = grp(all.filter((c) => { const cp = sc(c).capabilities || {}; return !(cp.drop || []).map(String).includes("ALL") || (cp.add || []).some((k) => String(k) !== "NET_BIND_SERVICE"); }), (w) => `unrestricted capabilities (${w} must set securityContext.capabilities.drop=["ALL"]; ${w.startsWith("containers") ? "containers" : "container"} must not include capabilities other than "NET_BIND_SERVICE" in securityContext.capabilities.add)`); if (x) out.push(x.replace(/; containers? must not include.*\)$/, ")"));
    const rv = (spec.volumes || []).filter((v) => !Object.keys(v).some((k) => OK_VOLS.includes(k)) && !v.hostPath); if (rv.length) out.push(`restricted volume types (${rv.map((v) => `volume "${v.name}"`).join(", ")})`);
    const nonRootMissing = all.filter((c) => sc(c).runAsNonRoot !== true && !(psc.runAsNonRoot === true && sc(c).runAsNonRoot !== false));
    if (nonRootMissing.length) out.push(`runAsNonRoot != true (pod or ${grp(nonRootMissing, (w) => w)} must set securityContext.runAsNonRoot=true)`);
    const root = all.filter((c) => sc(c).runAsUser === 0); if (psc.runAsUser === 0) out.push("runAsUser=0 (pod must not set runAsUser=0)"); x = grp(root, (w) => `runAsUser=0 (${w} must not set runAsUser=0)`); if (x) out.push(x);
    const sec = (o) => ["RuntimeDefault", "Localhost"].includes(((o || {}).seccompProfile || {}).type);
    const noSec = all.filter((c) => !sec(sc(c)) && !(sec(psc) && !(sc(c).seccompProfile)));
    if (noSec.length) out.push(`seccompProfile (pod or ${grp(noSec, (w) => w)} must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")`);
    return out;
  }
  function pssEval(I, src) {
    const r = K.yaml(src || ""); if (!r.ok) return { err: `YAML error: ${esc(r.err)}` };
    const pod = r.val;
    if (!isObj(pod) || pod.kind !== "Pod" || !isObj(pod.spec) || !Array.isArray(pod.spec.containers)) return { err: "Write a v1 Pod with spec.containers." };
    const spec = pod.spec, app = spec.containers.find((c) => c.name === "app");
    if (!app || app.image !== I.image) return { err: `Keep the <code>app</code> container with image <code>${esc(I.image)}</code>.` };
    const rows = [];
    const v = pssCheck(spec);
    rows.push({ name: `Admission: PodSecurity "restricted:latest" on namespace ${esc(I.ns)}`, want: "admitted", got: v.length ? `Error from server (Forbidden): pods "${esc((pod.metadata || {}).name || "app")}" is forbidden: violates PodSecurity "restricted:latest": ${esc(v.join(", "))}` : "admitted", ok: !v.length });
    if (v.length) return { rows };
    const sc = (c) => c.securityContext || {}, psc = spec.securityContext || {};
    const uid = (c) => (sc(c).runAsUser != null ? sc(c).runAsUser : psc.runAsUser != null ? psc.runAsUser : I.imageUser);
    const all = [...(spec.initContainers || []), ...spec.containers];
    const rootImg = all.find((c) => uid(c) === 0);
    rows.push({ name: "Containers start", want: "Running", got: rootImg ? `CreateContainerConfigError: container has runAsNonRoot and image will run as root (pod: "${esc((pod.metadata || {}).name || "app")}_${I.ns}", container: ${esc(rootImg.name)})` : "Running", ok: !rootImg });
    if (I.lv === 2) {
      const dataVol = (spec.volumes || []).find((x) => x.persistentVolumeClaim && x.persistentVolumeClaim.claimName === I.claim);
      const mounted = dataVol && (app.volumeMounts || []).some((m) => m.name === dataVol.name && m.mountPath === "/data");
      const fsg = psc.fsGroup != null && psc.fsGroup !== 0;
      rows.push({ name: "App writes to /data (fresh PVC, root-owned)", want: "write succeeds", got: !mounted ? `volume for PVC ${esc(I.claim)} not mounted at /data` : fsg ? `ok (volume group-owned by GID ${psc.fsGroup}, setgid)` : "open /data/segments/0001: permission denied", ok: !!mounted && fsg });
    }
    if (I.lv === 3) {
      const ro = all.every((c) => sc(c).readOnlyRootFilesystem === true);
      rows.push({ name: "Kyverno policy require-ro-rootfs", want: "readOnlyRootFilesystem: true on every container", got: ro ? "pass" : "fail: validation error: Root filesystem must be read-only. rule validate-readOnlyRootFilesystem failed", ok: ro });
      const tmpVol = (spec.volumes || []).find((x) => x.emptyDir);
      const tmp = tmpVol && (app.volumeMounts || []).some((m) => m.name === tmpVol.name && m.mountPath === "/tmp");
      rows.push({ name: "App writes temp files to /tmp", want: "write succeeds", got: !sc(app).readOnlyRootFilesystem || tmp ? "ok" : "open /tmp/upload-29341: read-only file system", ok: !sc(app).readOnlyRootFilesystem || !!tmp });
    }
    return { rows };
  }
  MORE.push({
    id: "k8s-pod-security", name: "Pass Pod Security admission", kind: "Hardening", skills: ["safe", "design"], w: "code",
    gen(lv, R) {
      const app = pick(R, ["thumbnailer", "importer", "indexer", "exporter"]);
      return { lv, app, ns: pick(R, ["media", "ingest", "search"]), image: `registry.corp.internal/${app}:${R.int(1, 3)}.${R.int(0, 30)}.${R.int(0, 9)}`, imageUser: lv === 3 ? 0 : 10001, claim: `${app}-data` };
    },
    text: (I) => `<p>Namespace <code>${esc(I.ns)}</code> now enforces the <b>restricted</b> Pod Security Standard (<code>pod-security.kubernetes.io/enforce: restricted</code>) and the <b>${esc(I.app)}</b> pod below is rejected.${I.lv === 1 ? " The image already runs as UID 10001." : I.lv === 2 ? ` The image runs as UID 10001 and writes to a PersistentVolume mounted at <code>/data</code>; a root init container used to <code>chown</code> it.` : " The image's Dockerfile never sets USER (it runs as root by default), but the app works as any UID. The cluster also runs a Kyverno policy requiring a read-only root filesystem, and the app writes temp files to <code>/tmp</code>."}</p><p>Fix the manifest so it's admitted and actually works. Checks run your manifest through the restricted profile's rules and a container start.</p>`,
    ui: (I) => {
      const vols = I.lv === 2 ? `  volumes:\n  - name: data\n    persistentVolumeClaim:\n      claimName: ${I.claim}\n` : "";
      const mounts = I.lv === 2 ? "    volumeMounts:\n    - name: data\n      mountPath: /data\n" : "";
      const init = I.lv === 2 ? "  initContainers:\n  - name: fix-perms\n    image: docker.io/library/busybox:1.36\n    command: [\"sh\", \"-c\", \"chown -R 10001:10001 /data\"]\n    securityContext:\n      runAsUser: 0\n    volumeMounts:\n    - name: data\n      mountPath: /data\n" : "";
      const starter = `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${I.app}\n  namespace: ${I.ns}\nspec:\n${init}  containers:\n  - name: app\n    image: ${I.image}\n${I.lv === 1 ? "    securityContext:\n      privileged: true\n" : ""}    ports:\n    - containerPort: 8080\n${mounts}${vols}`;
      return { lang: "yaml", file: `${I.app}.yaml`, rows: 24, starter, live: (src) => { if (!src || !src.trim()) return ""; const r = pssEval(I, src); return r.err ? `<p class="lose small">${r.err}</p>` : verdictRows(r.rows); } };
    },
    accept(I, src) { const r = pssEval(I, src); if (r.err) return r.err; const f = firstFail(r.rows); return f ? `<b>${esc(f.name)}</b>: ${f.got}` : true; },
    solve: (I) => {
      const csc = `    securityContext:\n      allowPrivilegeEscalation: false\n      capabilities:\n        drop: ["ALL"]\n${I.lv === 3 ? "      readOnlyRootFilesystem: true\n" : ""}`;
      const psc = `  securityContext:\n    runAsNonRoot: true\n${I.lv === 3 ? "    runAsUser: 10001\n    runAsGroup: 10001\n" : ""}${I.lv === 2 ? "    fsGroup: 10001\n" : ""}    seccompProfile:\n      type: RuntimeDefault\n`;
      const mounts = I.lv === 2 ? "    volumeMounts:\n    - name: data\n      mountPath: /data\n" : I.lv === 3 ? "    volumeMounts:\n    - name: tmp\n      mountPath: /tmp\n" : "";
      const vols = I.lv === 2 ? `  volumes:\n  - name: data\n    persistentVolumeClaim:\n      claimName: ${I.claim}\n` : I.lv === 3 ? "  volumes:\n  - name: tmp\n    emptyDir: {}\n" : "";
      return `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${I.app}\n  namespace: ${I.ns}\nspec:\n${psc}  containers:\n  - name: app\n    image: ${I.image}\n${csc}    ports:\n    - containerPort: 8080\n${mounts}${vols}`;
    },
    bad: (I) => {
      const s = MORE.find((x) => x.id === "k8s-pod-security").solve(I);
      return [s.replace("      allowPrivilegeEscalation: false\n", ""), s.replace("    seccompProfile:\n      type: RuntimeDefault\n", ""), ...(I.lv === 2 ? [s.replace("    fsGroup: 10001\n", "")] : []), ...(I.lv === 3 ? [s.replace("    runAsUser: 10001\n    runAsGroup: 10001\n", ""), s.replace(/    volumeMounts:\n    - name: tmp\n      mountPath: \/tmp\n/, "")] : [])];
    },
    hint: (I) => I.lv === 1 ? "restricted wants four things on every container: no privilege escalation, drop ALL capabilities, run as non-root, and a RuntimeDefault seccomp profile." : I.lv === 2 ? "A root init container can never pass restricted. Which pod-level setting makes the kubelet hand the volume to a group?" : "runAsNonRoot only <i>checks</i> the UID; if the image defaults to root, something has to set a UID. And a read-only root filesystem needs a writable place for temp files.",
    concept: "Pod Security Standards (restricted)",
    how: "Pod Security Admission enforces one of three profiles per namespace via labels. <b>restricted</b> requires every container (init ones included) to set allowPrivilegeEscalation: false, drop ALL capabilities (only NET_BIND_SERVICE may be added back), run as non-root, and use the RuntimeDefault or Localhost seccomp profile; privileged mode, host namespaces, hostPath and hostPort are forbidden. runAsNonRoot is a check, not a setting: if the image's user is root and no runAsUser is given, the kubelet refuses to start the container. <code>fsGroup</code> makes the kubelet give mounted volumes to that group, replacing root chown init containers.",
    rule: "Bake the restricted securityContext into your chart's defaults: runAsNonRoot with an explicit runAsUser, drop ALL, no privilege escalation, RuntimeDefault seccomp, fsGroup for volumes, and emptyDir for scratch paths.",
    why: (I) => I.lv === 1 ? "The pod asked for privileged mode and set none of restricted's four requirements. Removing privileged and adding them (pod-level runAsNonRoot and seccomp, container-level escalation and capabilities) gets it admitted; the image already runs as 10001, so it starts."
      : I.lv === 2 ? "The chown init container ran as root, which restricted forbids. fsGroup: 10001 makes the kubelet set the volume's group to 10001 (with setgid) on mount, so the non-root app can write to /data without any root step."
        : "With no USER in the image, runAsNonRoot alone fails at container start (CreateContainerConfigError); runAsUser: 10001 fixes it. The Kyverno policy's read-only root filesystem then broke /tmp, solved by mounting an emptyDir there.",
  });

  /* ===== kustomize overlay ===== */
  const K_BASE = (I) => [
    { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", labels: { app: "web" } }, spec: { replicas: 1, selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "web", image: `${I.image}:${I.baseTag}`, envFrom: [{ configMapRef: { name: "web-config" } }], resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "256Mi" } } }] } } } },
    { apiVersion: "v1", kind: "Service", metadata: { name: "web", labels: { app: "web" } }, spec: { selector: { app: "web" }, ports: [{ port: 80, targetPort: 8080 }] } },
  ];
  const BASE_CM = { LOG_LEVEL: "info", CACHE_TTL: "60" };
  function kustomize(I, src) {
    const r = K.yaml(src || ""); if (!r.ok) return { err: `YAML error: ${esc(r.err)}` };
    const k = r.val;
    if (!isObj(k)) return { err: "kustomization.yaml must be a map." };
    const known = ["apiVersion", "kind", "resources", "namespace", "namePrefix", "nameSuffix", "images", "replicas", "commonLabels", "labels", "patches", "configMapGenerator", "commonAnnotations"];
    const unk = Object.keys(k).filter((x) => !known.includes(x)); if (unk.length) return { err: `Error: invalid Kustomization: json: unknown field "${esc(unk[0])}"` };
    if (!Array.isArray(k.resources) || !k.resources.includes("../../base")) return { err: "The overlay must list <code>../../base</code> under resources." };
    const objs = K.clone(K_BASE(I));
    // base generator: web-config from literals
    let cmData = { ...BASE_CM };
    for (const g of k.configMapGenerator || []) {
      if (g.name !== "web-config") return { err: `This task only generates web-config (found ${esc(String(g.name))}).` };
      const lit = Object.fromEntries((g.literals || []).map((l) => { const i = String(l).indexOf("="); return [String(l).slice(0, i), String(l).slice(i + 1)]; }));
      if (!g.behavior || g.behavior === "create") return { err: `Error: merging from generator &amp;{web-config ...}: id resid.ResId{Gvk:resid.Gvk{Group:"", Version:"v1", Kind:"ConfigMap"}, Name:"web-config", Namespace:""} exists; behavior must be merge or replace` };
      if (g.behavior === "merge") cmData = { ...cmData, ...lit }; else if (g.behavior === "replace") cmData = lit; else return { err: `invalid generator behavior "${esc(g.behavior)}"` };
    }
    const cm = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "web-config" }, data: cmData };
    objs.push(cm);
    for (const pt of k.patches || []) {
      const body = isObj(pt) ? pt.patch : null; if (typeof body !== "string") return { err: "Each patches entry needs an inline <code>patch: |-</code> body (patch files aren't available here)." };
      const pr = K.yaml(body); if (!pr.ok) return { err: `patch YAML error: ${esc(pr.err)}` };
      if (Array.isArray(pr.val)) { const tg = pt.target || {}; const o = objs.find((x) => x.kind === tg.kind && x.metadata.name === tg.name); if (!o) return { err: "a JSON6902 patch needs a target with kind and name that exists in the base." }; try { Object.assign(o, X().jsonPatch(o, pr.val)); } catch (e) { return { err: `patch failed: ${esc(e.message)}` }; } continue; }
      const pv = pr.val || {}; const o = objs.find((x) => x.kind === pv.kind && x.metadata.name === (pv.metadata || {}).name);
      if (!o) return { err: `no matches for Id ${esc(String(pv.kind))}.${esc(String((pv.metadata || {}).name))}; failed to find unique target for patch` };
      Object.assign(o, X().smp(o, pv, null));
    }
    const addLabels = (pairs, sel, tpl) => objs.forEach((o) => {
      o.metadata.labels = { ...(o.metadata.labels || {}), ...pairs };
      if (o.kind === "Deployment") { if (sel || tpl) o.spec.template.metadata.labels = { ...o.spec.template.metadata.labels, ...pairs }; if (sel) o.spec.selector.matchLabels = { ...o.spec.selector.matchLabels, ...pairs }; }
      if (o.kind === "Service" && sel) o.spec.selector = { ...o.spec.selector, ...pairs };
    });
    if (k.commonLabels) addLabels(Object.fromEntries(Object.entries(k.commonLabels).map(([a, b]) => [a, String(b)])), true, true);
    for (const l of k.labels || []) addLabels(Object.fromEntries(Object.entries(l.pairs || {}).map(([a, b]) => [a, String(b)])), l.includeSelectors === true, l.includeTemplates === true);
    for (const im of k.images || []) objs.forEach((o) => { if (o.kind !== "Deployment") return; o.spec.template.spec.containers.forEach((c) => { const [nm, tg] = c.image.split(/:(?=[^:/]+$)/); if (nm === im.name) c.image = `${im.newName || nm}:${im.newTag != null ? im.newTag : tg}`; }); });
    for (const rp of k.replicas || []) objs.forEach((o) => { if (o.kind === "Deployment" && o.metadata.name === rp.name) o.spec.replicas = +rp.count; });
    const pre = k.namePrefix || "", suf = k.nameSuffix || "";
    const cmName = `${pre}web-config${suf}-${X().hstr(K.stable(cm.data), 10)}`;
    objs.forEach((o) => { o.metadata.name = o.kind === "ConfigMap" ? cmName : pre + o.metadata.name + suf; if (k.namespace) o.metadata.namespace = k.namespace; });
    objs.forEach((o) => { if (o.kind === "Deployment") o.spec.template.spec.containers.forEach((c) => (c.envFrom || []).forEach((e) => { if (e.configMapRef && e.configMapRef.name === "web-config") e.configMapRef.name = cmName; })); });
    return { objs };
  }
  function kzChecks(I, src) {
    const r = kustomize(I, src); if (r.err) return r;
    const dep = r.objs.find((o) => o.kind === "Deployment"), svc = r.objs.find((o) => o.kind === "Service"), cm = r.objs.find((o) => o.kind === "ConfigMap");
    const c = dep.spec.template.spec.containers[0];
    const rows = [
      { name: "Namespace", want: I.ns, got: r.objs.map((o) => o.metadata.namespace || "(none)").filter((v, i, a) => a.indexOf(v) === i).join(", "), ok: r.objs.every((o) => o.metadata.namespace === I.ns) },
      { name: "Deployment name (prod objects already exist)", want: "web", got: dep.metadata.name, ok: dep.metadata.name === "web" },
      { name: "Image", want: `${I.image}:${I.tag}`, got: c.image, ok: c.image === `${I.image}:${I.tag}` },
      { name: "Replicas", want: String(I.replicas), got: String(dep.spec.replicas), ok: dep.spec.replicas === I.replicas },
    ];
    if (I.lv >= 2) {
      const sel = K.stable(dep.spec.selector.matchLabels) === K.stable({ app: "web" }) && K.stable(svc.spec.selector) === K.stable({ app: "web" });
      rows.push({ name: "Selectors unchanged (spec.selector is immutable)", want: "app=web", got: sel ? "app=web" : `${lbl(dep.spec.selector.matchLabels)}: The Deployment "web" is invalid: spec.selector: Invalid value: field is immutable`, ok: sel });
      const want = I.labels, has = (o) => Object.entries(want).every(([a, b]) => (o || {})[a] === b);
      const lab = r.objs.every((o) => has(o.metadata.labels)) && has(dep.spec.template.metadata.labels);
      rows.push({ name: "Labels on all objects and on pods", want: lbl(want), got: lab ? "present" : "missing on " + [...r.objs.filter((o) => !has(o.metadata.labels)).map((o) => o.kind), ...(has(dep.spec.template.metadata.labels) ? [] : ["pod template"])].join(", "), ok: lab });
      const mem = ((c.resources || {}).limits || {}).memory, rq = ((c.resources || {}).requests || {}).memory;
      rows.push({ name: "Prod memory", want: `requests ${I.mem}, limits ${I.mem}`, got: `requests ${rq}, limits ${mem}`, ok: mem === I.mem && rq === I.mem });
    }
    if (I.lv === 3) {
      const ref = (c.envFrom || []).map((e) => (e.configMapRef || {}).name)[0];
      rows.push({ name: "ConfigMap data", want: lbl({ ...BASE_CM, LOG_LEVEL: I.logLevel }), got: lbl(cm.data), ok: K.stable(cm.data) === K.stable({ ...BASE_CM, LOG_LEVEL: I.logLevel }) });
      rows.push({ name: "Config change rolls the pods (hashed name referenced)", want: "envFrom → web-config-<hash>", got: ref, ok: ref === cm.metadata.name && /-[a-z0-9]{10}$/.test(ref) });
    }
    return { rows, objs: r.objs };
  }
  MORE.push({
    id: "k8s-kustomize-overlay", name: "Write the prod overlay", kind: "Config change", skills: ["design", "safe"], w: "code",
    gen(lv, R) {
      const I = { lv, ns: pick(R, ["shop-prod", "web-prod", "store-prod"]), image: `registry.corp.internal/shop/web`, baseTag: "dev", tag: `${R.int(1, 4)}.${R.int(0, 20)}.${R.int(0, 9)}`, replicas: R.int(3, 8) };
      if (lv >= 2) { I.labels = { env: "prod", team: pick(R, ["checkout", "storefront", "growth"]) }; I.mem = pick(R, ["768Mi", "1Gi", "1536Mi"]); }
      if (lv === 3) I.logLevel = pick(R, ["warn", "error"]);
      return I;
    },
    text: (I) => `<p>The base (<code>base/</code>) renders a Deployment <b>web</b> (image <code>${I.image}:dev</code>, 1 replica, selector <code>app=web</code>, 256Mi memory), a Service <b>web</b>, and a generated ConfigMap <b>web-config</b> (<code>configMapGenerator</code> literals LOG_LEVEL=info, CACHE_TTL=60) that the Deployment reads with envFrom. Write <code>overlays/prod/kustomization.yaml</code>: namespace <code>${esc(I.ns)}</code>, image tag <b>${esc(I.tag)}</b>, <b>${I.replicas}</b> replicas${I.lv >= 2 ? `, labels <code>${lbl(I.labels)}</code> on every object and on the pods, memory request and limit <b>${I.mem}</b> (inline patch). The prod Deployment already exists, created from the base` : ""}${I.lv === 3 ? `, and LOG_LEVEL=<b>${I.logLevel}</b> in prod, keeping the other config keys, in a way that rolls the pods whenever config changes` : ""}.</p>`,
    ui: (I) => ({ lang: "yaml", file: "overlays/prod/kustomization.yaml", rows: 22, starter: "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n- ../../base\n", live: (src) => { if (!src || !src.trim()) return ""; const r = kzChecks(I, src); if (r.err) return `<p class="lose small">${r.err}</p>`; return verdictRows(r.rows) + `<details><summary class="small">kustomize build output</summary>${K.pre(r.objs.map((o) => X().toYaml(o)).join("\n---\n"))}</details>`; } }),
    accept(I, src) { const r = kzChecks(I, src); if (r.err) return r.err; const f = firstFail(r.rows); return f ? `<b>${esc(f.name)}</b>: got ${esc(f.got)}, want ${esc(f.want)}.` : true; },
    solve: (I) => `apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n- ../../base\nnamespace: ${I.ns}\nimages:\n- name: ${I.image}\n  newTag: "${I.tag}"\nreplicas:\n- name: web\n  count: ${I.replicas}\n` + (I.lv >= 2 ? `labels:\n- pairs:\n${Object.entries(I.labels).map(([a, b]) => `    ${a}: ${b}`).join("\n")}\n  includeTemplates: true\npatches:\n- patch: |-\n    apiVersion: apps/v1\n    kind: Deployment\n    metadata:\n      name: web\n    spec:\n      template:\n        spec:\n          containers:\n          - name: web\n            resources:\n              requests:\n                memory: ${I.mem}\n              limits:\n                memory: ${I.mem}\n` : "") + (I.lv === 3 ? `configMapGenerator:\n- name: web-config\n  behavior: merge\n  literals:\n  - LOG_LEVEL=${I.logLevel}\n` : ""),
    bad: (I) => { const s = MORE.find((x) => x.id === "k8s-kustomize-overlay").solve(I); return [s.replace(`  newTag: "${I.tag}"`, `  newName: ${I.image}:${I.tag}`), ...(I.lv >= 2 ? [s.replace(/labels:\n- pairs:\n((?:    .*\n)+)  includeTemplates: true\n/, (m, body) => "commonLabels:\n" + body.replace(/^    /gm, "  "))] : []), ...(I.lv === 3 ? [s.replace("behavior: merge", "behavior: replace")] : [s.replace(/namespace: .*\n/, "namePrefix: prod-\n")])]; },
    hint: (I) => I.lv === 1 ? "images: matches a container image by name and swaps the tag; replicas: sets spec.replicas by Deployment name." : I.lv === 2 ? "commonLabels also rewrites selectors, which an existing Deployment can't change. The newer labels: field lets you choose." : "The base already generates web-config; an overlay generator for the same name must say how to combine (behavior).",
    concept: "Kustomize overlays",
    how: "An overlay lists the base under <code>resources</code> and transforms what it renders: <code>namespace</code>, <code>images</code> (retag by image name), <code>replicas</code>, label transformers and <code>patches</code> (strategic merge or JSON 6902, inline or from files). <code>commonLabels</code> adds labels to selectors too, which is fine for new objects but breaks existing Deployments, whose spec.selector is immutable; the <code>labels</code> field with includeSelectors/includeTemplates gives control. <code>configMapGenerator</code> appends a content hash to the ConfigMap name and rewrites references, so a config change becomes a new pod template and a rolling update; an overlay can merge into or replace a base generator.",
    rule: "Keep selectors stable forever, label pods with labels: + includeTemplates, and generate ConfigMaps (hashed) so config changes roll out like code.",
    why: (I) => I.lv === 1 ? `namespace, images (tag ${esc(I.tag)}) and replicas (${I.replicas}) are pure transformers; no patch needed.`
      : I.lv === 2 ? `The labels transformer with includeTemplates puts ${lbl(I.labels)} on objects and pods but leaves the selector at app=web; commonLabels would have changed the selector and the apply would fail on the immutable field. The memory change is a small strategic-merge patch keyed by container name.`
        : `behavior: merge overrides LOG_LEVEL while keeping CACHE_TTL from the base generator (replace would drop it). The generated name carries a content hash and the Deployment's envFrom is rewritten to it, so changing a value rolls the pods.`,
  });

  /* ===== native sidecars ===== */
  const SC_IMG = { "log-shipper": "docker.io/fluent/fluent-bit:3.1.9", proxy: "registry.corp.internal/mesh/proxy:1.23.2", "wait-for-db": "docker.io/library/busybox:1.36" };
  function sidecarSim(I, src) {
    const r = K.yaml(src || ""); if (!r.ok) return { err: `YAML error: ${esc(r.err)}` };
    const spec = r.val;
    if (!isObj(spec) || !Array.isArray(spec.containers)) return { err: "Write the pod spec (containers, initContainers, ...)." };
    const inits = spec.initContainers || [], ctrs = spec.containers;
    const all = [...inits, ...ctrs];
    for (const n of I.names) { const c = all.filter((x) => x.name === n); if (c.length !== 1) return { err: `Container <code>${n}</code> must appear exactly once.` }; const want = n === I.main ? I.mainImg : SC_IMG[n]; if (c[0].image !== want) return { err: `Keep ${n}'s image <code>${esc(want)}</code>.` }; }
    if (all.length !== I.names.length) return { err: `Only these containers belong here: ${I.names.join(", ")}.` };
    const isSide = (n) => n === "proxy" || n === "log-shipper";
    const rows = [];
    let t = 0, fail = null;
    const started = {}, readyAt = {};
    for (const c of inits) {
      if (c.restartPolicy === "Always") {
        if (!isSide(c.name)) { fail = `${c.name} is a run-to-completion step; with restartPolicy: Always it would be restarted forever`; break; }
        started[c.name] = t; readyAt[c.name] = t + (c.name === "proxy" ? I.proxyBoot : 1);
        if (c.startupProbe) t = readyAt[c.name];
        continue;
      }
      if (c.restartPolicy) { fail = `initContainers[].restartPolicy may only be "Always"`; break; }
      if (isSide(c.name)) { fail = `${c.name} never exits, so as a plain init container it blocks the pod in Init:0/${inits.length} forever`; break; }
      if (c.name === "wait-for-db" && !(started.proxy != null && readyAt.proxy <= t)) { fail = `wait-for-db failed: the database is only reachable through the mesh proxy, which ${started.proxy == null ? "isn't running yet" : "wasn't ready yet"} (Init:CrashLoopBackOff)`; break; }
      t += 2;
    }
    rows.push({ name: "Init phase", want: "completes", got: fail || `done at t=${t}s`, ok: !fail });
    if (!fail) {
      const proxyNative = started.proxy != null, proxyRegular = ctrs.some((c) => c.name === "proxy");
      if (I.mainNeedsProxy) {
        const ok = proxyNative && readyAt.proxy <= t;
        rows.push({ name: `${I.main} connects through the proxy at startup`, want: "proxy ready first", got: ok ? `proxy ready at ${readyAt.proxy}s, ${I.main} starts at ${t}s` : proxyRegular ? `${I.main} and proxy start together; first DB connection refused, ${I.main} exits 1` : `proxy started at ${started.proxy}s but only ready at ${readyAt.proxy}s; ${I.main} started at ${t}s and its first connection was refused`, ok });
      }
      if (I.job) {
        const blockers = ctrs.filter((c) => isSide(c.name));
        rows.push({ name: "Job completes when the main container exits", want: "Complete", got: blockers.length ? `pod stays Running: ${blockers.map((c) => c.name).join(", ")} never exit${blockers.length > 1 ? "" : "s"}` : "Complete (sidecars stopped after main exited)", ok: !blockers.length });
      }
      if (I.logsLast) {
        const order = inits.filter((c) => c.restartPolicy === "Always").map((c) => c.name);
        const ok = order.includes("log-shipper") && order.includes("proxy") && order.indexOf("log-shipper") < order.indexOf("proxy");
        rows.push({ name: "Proxy access logs from shutdown are shipped", want: "log-shipper stops last", got: ok ? "proxy stopped first, then log-shipper flushed" : !order.includes("log-shipper") ? "log-shipper isn't a native sidecar" : "log-shipper stopped before proxy finished writing (sidecars stop in reverse start order)", ok });
      }
    }
    return { rows };
  }
  MORE.push({
    id: "k8s-native-sidecar", name: "Fix the sidecar lifecycle", kind: "Config change", skills: ["design"], w: "code",
    gen(lv, R) {
      const I = { lv, proxyBoot: R.int(2, 6) };
      if (lv === 1) Object.assign(I, { main: "export", mainImg: `registry.corp.internal/jobs/export:${R.int(1, 9)}.${R.int(0, 9)}`, names: ["export", "log-shipper"], job: true });
      if (lv === 2) Object.assign(I, { main: "app", mainImg: `registry.corp.internal/shop/${pick(R, ["orders", "cart", "ledger"])}:${R.int(1, 9)}.${R.int(0, 9)}`, names: ["app", "proxy"], mainNeedsProxy: true });
      if (lv === 3) Object.assign(I, { main: "migrate", mainImg: `registry.corp.internal/jobs/migrate:${R.int(1, 9)}.${R.int(0, 9)}`, names: ["wait-for-db", "migrate", "proxy", "log-shipper"], job: true, mainNeedsProxy: true, logsLast: true });
      return I;
    },
    text: (I) => I.lv === 1 ? `<p>The nightly <b>export</b> Job never finishes: the export container exits 0 after a few minutes, but the pod stays Running and the Job never reaches Complete, so the next night's run is skipped. The <code>log-shipper</code> sidecar runs forever by design. The cluster runs Kubernetes 1.31.</p><p>Rewrite the pod spec so the Job completes and logs are still shipped while export runs.</p>`
      : I.lv === 2 ? `<p>Pods of a mesh-enabled service crash once on every start: the app opens its first database connection through the <code>proxy</code> container, which takes about ${I.proxyBoot}s to become ready (it serves <code>/healthz/ready</code> on port 15021). Kubernetes 1.31.</p><p>Rewrite the pod spec so the app only starts once the proxy is ready.</p>`
        : `<p>A database migration Job needs: the mesh <code>proxy</code> (ready after ~${I.proxyBoot}s, <code>/healthz/ready</code> on 15021) for every DB connection, including the <code>wait-for-db</code> init step; the Job to complete when <code>migrate</code> exits; and <code>log-shipper</code> to ship everything, including the proxy's access logs written during shutdown. Kubernetes 1.31.</p><p>Rewrite the pod spec.</p>`,
    ui: (I) => ({ lang: "yaml", file: "pod spec", rows: 22, starter: I.lv === 1 ? `restartPolicy: Never\ncontainers:\n- name: export\n  image: ${I.mainImg}\n- name: log-shipper\n  image: ${SC_IMG["log-shipper"]}\n` : I.lv === 2 ? `containers:\n- name: app\n  image: ${I.mainImg}\n- name: proxy\n  image: ${SC_IMG.proxy}\n` : `restartPolicy: Never\ninitContainers:\n- name: wait-for-db\n  image: ${SC_IMG["wait-for-db"]}\n  command: ["sh", "-c", "until nc -z postgres 5432; do sleep 1; done"]\ncontainers:\n- name: migrate\n  image: ${I.mainImg}\n- name: proxy\n  image: ${SC_IMG.proxy}\n- name: log-shipper\n  image: ${SC_IMG["log-shipper"]}\n`, live: (src) => { if (!src || !src.trim()) return ""; const r = sidecarSim(I, src); return r.err ? `<p class="lose small">${r.err}</p>` : verdictRows(r.rows); } }),
    accept(I, src) { const r = sidecarSim(I, src); if (r.err) return r.err; const f = firstFail(r.rows); return f ? `<b>${esc(f.name)}</b>: ${esc(f.got)}.` : true; },
    solve: (I) => {
      const proxy = `- name: proxy\n  image: ${SC_IMG.proxy}\n  restartPolicy: Always\n  startupProbe:\n    httpGet:\n      path: /healthz/ready\n      port: 15021\n    periodSeconds: 1\n    failureThreshold: 30\n`;
      const ship = `- name: log-shipper\n  image: ${SC_IMG["log-shipper"]}\n  restartPolicy: Always\n`;
      if (I.lv === 1) return `restartPolicy: Never\ninitContainers:\n${ship}containers:\n- name: export\n  image: ${I.mainImg}\n`;
      if (I.lv === 2) return `initContainers:\n${proxy}containers:\n- name: app\n  image: ${I.mainImg}\n`;
      return `restartPolicy: Never\ninitContainers:\n${ship}${proxy}- name: wait-for-db\n  image: ${SC_IMG["wait-for-db"]}\n  command: ["sh", "-c", "until nc -z postgres 5432; do sleep 1; done"]\ncontainers:\n- name: migrate\n  image: ${I.mainImg}\n`;
    },
    bad: (I) => { const s = MORE.find((x) => x.id === "k8s-native-sidecar").solve(I); return I.lv === 1 ? [s.replace("  restartPolicy: Always\n", "")] : I.lv === 2 ? [s.replace(/  startupProbe:\n(    .*\n)+/, "")] : [s.replace(/(- name: log-shipper\n.*\n  restartPolicy: Always\n)(- name: proxy\n(?:  .*\n|    .*\n|      .*\n)+?)(- name: wait-for-db)/, "$2$1$3"), s.replace(/(initContainers:\n)((?:- name: log-shipper\n[\s\S]*?))(- name: wait-for-db\n.*\n.*\n)/, "$1$3$2")]; },
    hint: (I) => I.lv === 1 ? "Since 1.29 (on by default), an init container with restartPolicy: Always is a sidecar: it keeps running beside the main containers and is stopped when they finish." : I.lv === 2 ? "The kubelet starts the next container only once a sidecar's startupProbe succeeds." : "Order matters both ways: init containers start in list order, and sidecars are stopped in reverse order after the main container exits.",
    concept: "Native sidecar containers",
    how: "A native sidecar is an entry in <code>initContainers</code> with <code>restartPolicy: Always</code> (beta and on by default since Kubernetes 1.29). It starts in order with the other init containers but doesn't need to exit; if it has a startupProbe, the kubelet waits for it before starting the next container, so later init containers and the app can rely on it. Sidecars don't count towards Job completion: once the regular containers finish, the kubelet stops sidecars in the reverse order they started. A sidecar listed in <code>containers</code> gets none of this.",
    rule: "Put proxies and log shippers in initContainers with restartPolicy: Always, give anything others depend on a startupProbe, and list sidecars in the order you want them started (they stop in reverse).",
    why: (I) => I.lv === 1 ? "As a regular container the log shipper kept the pod Running after export exited, so the Job never completed. As a native sidecar it runs alongside export and is stopped once export finishes."
      : I.lv === 2 ? `Without a startupProbe the kubelet starts the app as soon as the proxy process starts, ${I.proxyBoot}s before it can route. With the probe, the app starts only after the proxy reports ready.`
        : "log-shipper first, then proxy (with a startupProbe), then wait-for-db: the proxy is ready before wait-for-db needs it, migrate finishes the Job, and on shutdown the proxy stops before the log shipper that collects its access logs.",
  });

  /* ===== topology spread ===== */
  function spreadSim(I, src) {
    const r = K.yaml(src || ""); if (!r.ok) return { err: `YAML error: ${esc(r.err)}` };
    const spec = r.val || {};
    if (!isObj(spec)) return { err: "Expected pod spec fields (topologySpreadConstraints, affinity)." };
    const extra = Object.keys(spec).filter((k) => !["topologySpreadConstraints", "affinity"].includes(k)); if (extra.length) return { err: `Only topologySpreadConstraints and affinity belong here (found ${esc(extra.join(", "))}).` };
    const tsc = spec.topologySpreadConstraints || [];
    for (const c of tsc) {
      if (!isObj(c) || !c.topologyKey || !c.whenUnsatisfiable || c.maxSkew == null) return { err: "Each topologySpreadConstraint needs maxSkew, topologyKey and whenUnsatisfiable." };
      if (!["DoNotSchedule", "ScheduleAnyway"].includes(c.whenUnsatisfiable)) return { err: `whenUnsatisfiable must be DoNotSchedule or ScheduleAnyway.` };
      if (+c.maxSkew < 1) return { err: "maxSkew must be at least 1." };
    }
    const nodes = I.nodes, podLabels = { app: I.app };
    const aff = (spec.affinity || {}).nodeAffinity, terms = ((aff || {}).requiredDuringSchedulingIgnoredDuringExecution || {}).nodeSelectorTerms;
    const nodeAffOk = (n) => !terms || terms.some((t) => (t.matchExpressions || []).every((e) => { const v = n.labels[e.key]; const vals = (e.values || []).map(String); return e.operator === "In" ? vals.includes(v) : e.operator === "NotIn" ? !vals.includes(v) : e.operator === "Exists" ? v != null : v == null; }));
    const tainted = (n) => !!n.taint;
    const antiReq = (((spec.affinity || {}).podAntiAffinity || {}).requiredDuringSchedulingIgnoredDuringExecution || []);
    const place = [];
    const cnt = (n) => place.filter((x) => x === n.name).length;
    const dom = (n, key) => n.labels[key];
    for (let k = 0; k < I.n; k++) {
      const cand = nodes.filter((n) => !tainted(n) && nodeAffOk(n) && cnt(n) < n.cap && antiReq.every((a) => !selMatches(a.labelSelector, podLabels) || !place.some((pn) => dom(nodes.find((x) => x.name === pn), a.topologyKey) === dom(n, a.topologyKey))) && tsc.filter((c) => c.whenUnsatisfiable === "DoNotSchedule").every((c) => {
        const elig = nodes.filter((m) => (c.nodeAffinityPolicy === "Ignore" || nodeAffOk(m)) && (c.nodeTaintsPolicy !== "Honor" || !tainted(m)) && m.labels[c.topologyKey] != null);
        if (!elig.includes(n)) return false;
        const doms = [...new Set(elig.map((m) => dom(m, c.topologyKey)))];
        const match = selMatches(c.labelSelector, podLabels);
        const per = (d) => (match ? place.filter((pn) => dom(nodes.find((x) => x.name === pn), c.topologyKey) === d).length : 0);
        const min = Math.min(...doms.map(per));
        return per(dom(n, c.topologyKey)) + (match ? 1 : 0) - min <= +c.maxSkew;
      }));
      if (!cand.length) break;
      const z = (n) => place.filter((pn) => nodes.find((x) => x.name === pn).labels.zone === n.labels.zone).length;
      cand.sort((a, b) => z(b) - z(a) || cnt(b) - cnt(a) || (a.name < b.name ? -1 : 1));
      place.push(cand[0].name);
    }
    const zones = [...new Set(nodes.map((n) => n.labels.zone))];
    const perZone = Object.fromEntries(zones.map((zz) => [zz, place.filter((pn) => nodes.find((x) => x.name === pn).labels.zone === zz).length]));
    const worst = Math.min(...zones.map((zz) => place.length - perZone[zz]));
    const rows = [
      { name: `All ${I.n} replicas scheduled`, want: `${I.n} Running`, got: `${place.length} Running${place.length < I.n ? `, ${I.n - place.length} Pending` : ""}`, ok: place.length === I.n },
      { name: "Worst single-zone outage", want: `≥ ${I.keep} keep serving`, got: `${worst} left`, ok: worst >= I.keep },
    ];
    if (I.lv === 3) { const hard = tsc.some((c) => c.topologyKey === "topology.kubernetes.io/zone" && +c.maxSkew === 1 && c.whenUnsatisfiable === "DoNotSchedule"); rows.push({ name: "Team policy: zone spread maxSkew 1, DoNotSchedule", want: "present", got: hard ? "present" : "missing", ok: hard }); }
    return { rows, perZone, place };
  }
  const zoneTable = (I, r) => K.table(["Zone", "Nodes (free slots)", "Replicas"], [...new Set(I.nodes.map((n) => n.labels.zone))].map((z) => [z, I.nodes.filter((n) => n.labels.zone === z).map((n) => `${n.name} (${n.cap})${n.taint ? " tainted" : ""}`).join(", "), String(r.perZone[z])]), { compact: true });
  MORE.push({
    id: "k8s-topology-spread", name: "Spread replicas across zones", kind: "Design review", skills: ["design", "safe"], w: "code",
    gen(lv, R) {
      const app = pick(R, ["checkout", "search", "gateway", "ledger"]);
      const N = (z, k, cap, taint) => ({ name: `node-${z.slice(-1)}${k}`, cap, taint: taint || null, labels: { zone: z, "topology.kubernetes.io/zone": z, "kubernetes.io/hostname": `node-${z.slice(-1)}${k}` } });
      const [a, b, c] = ["eu-west-1a", "eu-west-1b", "eu-west-1c"];
      if (lv === 1) return { lv, app, n: 3, keep: 2, nodes: [N(a, 1, 4), N(a, 2, 4), N(a, 3, 4), N(b, 1, 2), N(c, 1, 2)] };
      if (lv === 2) return { lv, app, n: 6, keep: 3, nodes: [N(a, 1, 4), N(a, 2, 4), N(b, 1, 3), N(b, 2, 2), N(c, 1, 1)] };
      return { lv, app, n: 6, keep: 3, nodes: [N(a, 1, 3), N(a, 2, 3), N(b, 1, 3), N(b, 2, 3), N(c, 1, 4, "nvidia.com/gpu"), N(c, 2, 4, "nvidia.com/gpu")] };
    },
    text: (I) => `<p>Write the scheduling section for <b>${esc(I.app)}</b> (pods labelled <code>app=${esc(I.app)}</code>, ${I.n} replicas) so that all replicas run and losing any one zone leaves at least <b>${I.keep}</b> serving. The check assumes the worst: wherever the rules allow it, the scheduler packs replicas into the same zone (soft preferences aren't guarantees).${I.lv === 2 ? " Zone c is nearly full." : I.lv === 3 ? " The team policy requires a hard zone spread with maxSkew 1. Zone c's nodes are GPU nodes tainted <code>nvidia.com/gpu:NoSchedule</code>, which these pods don't tolerate." : ""}</p><p>Zones use the label <code>topology.kubernetes.io/zone</code>.</p>`,
    ui: (I) => ({ lang: "yaml", file: "pod spec (scheduling)", rows: 14, starter: "topologySpreadConstraints:\n- maxSkew: 1\n  topologyKey: topology.kubernetes.io/zone\n  whenUnsatisfiable: ScheduleAnyway\n  labelSelector:\n    matchLabels:\n      app: " + I.app + "\n", live: (src) => { if (!src || !src.trim()) return ""; const r = spreadSim(I, src); return r.err ? `<p class="lose small">${r.err}</p>` : verdictRows(r.rows) + zoneTable(I, r); } }),
    accept(I, src) { const r = spreadSim(I, src); if (r.err) return r.err; const f = firstFail(r.rows); return f ? `<b>${esc(f.name)}</b>: ${esc(f.got)} (want ${esc(f.want)}).` : true; },
    solve: (I) => `topologySpreadConstraints:\n- maxSkew: ${I.lv === 2 ? 2 : 1}\n  topologyKey: topology.kubernetes.io/zone\n  whenUnsatisfiable: DoNotSchedule\n${I.lv === 3 ? "  nodeTaintsPolicy: Honor\n" : ""}  labelSelector:\n    matchLabels:\n      app: ${I.app}\n`,
    bad: (I) => { const s = `topologySpreadConstraints:\n- maxSkew: 1\n  topologyKey: topology.kubernetes.io/zone\n  whenUnsatisfiable: DoNotSchedule\n  labelSelector:\n    matchLabels:\n      app: ${I.app}\n`; return I.lv === 1 ? [s.replace("DoNotSchedule", "ScheduleAnyway"), s.replace(`      app: ${I.app}\n`, "      app: other\n")] : I.lv === 2 ? [s, s.replace("DoNotSchedule", "ScheduleAnyway")] : [s, s.replace("maxSkew: 1", "maxSkew: 3")]; },
    hint: (I) => I.lv === 1 ? "ScheduleAnyway is a preference. Which setting makes the spread a rule?" : I.lv === 2 ? "With maxSkew 1, can zone c (one free slot) ever stop being the minimum?" : "Do tainted nodes still count as a zone (a domain with 0 replicas) when the scheduler computes skew?",
    concept: "Topology spread constraints",
    how: "A topologySpreadConstraint counts matching pods per topology domain (zones here) and, with <code>DoNotSchedule</code>, refuses any node where count + 1 − (global minimum) would exceed maxSkew; <code>ScheduleAnyway</code> only scores. The minimum is taken over all eligible domains, including ones that are full, so a nearly full zone can block placement everywhere. Which nodes define domains is controlled by nodeAffinityPolicy (default Honor: nodes the pod can't select are ignored) and nodeTaintsPolicy (default Ignore: tainted nodes still count, as a zone that stays at 0).",
    rule: "Use DoNotSchedule for availability guarantees, size maxSkew to real per-zone capacity, and set nodeTaintsPolicy: Honor when some zones are tainted for other workloads.",
    why: (I) => I.lv === 1 ? "ScheduleAnyway lets the scheduler put all three replicas in zone a, the biggest. DoNotSchedule with maxSkew 1 forces one per zone, so any zone outage leaves two."
      : I.lv === 2 ? "Zone c can hold only one replica, so with maxSkew 1 the spread stalls at 2/2/1 and the sixth replica stays Pending. maxSkew 2 allows 3/2/1: still at least 3 left after any zone loss."
        : "Zone c's tainted GPU nodes still formed a domain with 0 replicas, capping zones a and b at one replica each. nodeTaintsPolicy: Honor drops them from the calculation, giving 3/3 across a and b while keeping the hard maxSkew 1.",
  });

  /* ===== rolling update strategy (tune) ===== */
  const pctN = (v, N, up) => (typeof v === "string" && v.endsWith("%") ? (up ? Math.ceil((N * parseFloat(v)) / 100 - 1e-9) : Math.floor((N * parseFloat(v)) / 100 + 1e-9)) : +v);
  function rollSim(I, cfg) {
    const N = I.n, s = pctN(cfg.surge, N, true), u = pctN(cfg.unav, N, false), mrs = +(cfg.mrs || 0);
    if (!s && !u) return { err: "maxSurge and maxUnavailable can't both be 0: the API server rejects the Deployment." };
    const slots = N + I.spare;
    let old = N, t = 0, minCap = N;
    const neu = []; // {start, ready, avail, capable} or pending {pending:true}
    const series = [];
    for (; t <= 3600; t++) {
      // pending pods start when a slot is free
      const running = () => old + neu.filter((p) => !p.pending).length;
      neu.forEach((p) => { if (p.pending && running() < slots) { p.pending = false; p.start = t; } });
      // controller: create new pods up to N + s total, never more than N new
      while (neu.length < N && old + neu.length < N + s) { const p = { pending: running() >= slots, start: t }; neu.push(p); }
      const avail = neu.filter((p) => !p.pending && t >= p.start + I.boot + mrs).length;
      const capable = neu.filter((p) => !p.pending && t >= p.start + I.boot + I.warm).length;
      // scale down old while availability stays >= N - u
      while (old > 0 && old - 1 + avail >= N - u) old--;
      neu.forEach((p) => { if (p.pending && running() < slots) { p.pending = false; p.start = t; } });
      const cap = old + capable;
      minCap = Math.min(minCap, cap);
      if (t % 5 === 0) series.push([t, cap]);
      if (old === 0 && capable === N && avail === N) break;
    }
    const done = t <= 3600;
    return { dur: t, minCap, done, series, s, u };
  }
  MORE.push({
    id: "k8s-rolling-update", name: "Tune the rolling update", kind: "Config change", skills: ["tune", "safe"], w: "tune", sense: "min", vname: "a rollout time of",
    vfmt: (x) => `${x}s`,
    gen(lv, R) {
      const n = lv === 1 ? R.pick([6, 8]) : R.pick([8, 10, 12]);
      const I = { lv, n, app: pick(R, ["checkout", "search", "catalog"]), boot: R.pick([20, 30, 40]), spare: lv === 1 ? 0 : R.int(2, 3), warm: 0 };
      I.need = lv === 1 ? n - 2 : n;
      if (lv === 3) { I.warm = R.pick([30, 45]); I.need = n; }
      I.warm = Math.max(I.warm, 0);
      return I;
    },
    text: (I) => `<p><b>${esc(I.app)}</b> runs ${I.n} replicas; pods take <b>${I.boot}s</b> to pass readiness${I.warm ? `, but their JIT and caches need another <b>${I.warm}s</b> before they can take a full share of traffic` : ""}. Peak traffic needs at least <b>${I.need}</b> fully capable pods at all times. The cluster has room for <b>${I.spare}</b> extra pod${I.spare === 1 ? "" : "s"} beyond the ${I.n} (more surge pods stay Pending until old ones go).</p><p>Choose the rollout settings that never drop below ${I.need} capable pods and finish as fast as possible.</p>`,
    ui: (I) => ({ knobs: [{ k: "surge", label: "maxSurge", opts: [0, 1, 2, "25%", "50%", "100%"] }, { k: "unav", label: "maxUnavailable", opts: [0, 1, 2, "25%", "50%"] }, ...(I.lv === 3 ? [{ k: "mrs", label: "minReadySeconds", opts: [0, 15, 30, 45, 60], unit: "s", help: "how long a new pod must stay Ready before it counts as available" }] : [])], init: { surge: "25%", unav: "25%", mrs: 0 },
      live: (cfg) => { const r = rollSim(I, cfg); if (r.err) return K.verdict(false, r.err); return K.metrics([{ name: "maxSurge / maxUnavailable (in pods)", value: `${r.s} / ${r.u}`, ok: null }, { name: "Lowest capable pods", value: String(r.minCap), ok: r.minCap >= I.need, target: `≥ ${I.need}` }, { name: "Rollout time", value: r.done ? `${r.dur}s` : "stalls", ok: r.done }]) + K.chart([{ name: "capable pods", pts: r.series }], { hline: { y: I.need, label: "needed" }, ymin: 0, xlabel: "s", title: "Capable pods during the rollout" }); } }),
    valid: (I, cfg) => { const r = rollSim(I, cfg); if (r.err) return r.err; if (!r.done) return "the rollout never finishes"; return r.minCap >= I.need ? true : `capacity drops to ${r.minCap} capable pods (need ${I.need})`; },
    val: (I, cfg) => rollSim(I, cfg).dur,
    hint: (I) => I.lv === 1 ? "With no spare room, surge pods can't start until old pods are gone. How many may be unavailable at once?" : I.lv === 2 ? "Nothing may be unavailable, so speed has to come from surge. How much surge can the cluster actually run?" : "The controller removes an old pod as soon as a new one counts as available. When does a new pod count as available, and when is it really capable?",
    concept: "maxSurge, maxUnavailable and minReadySeconds",
    how: "A rolling update keeps total pods ≤ replicas + maxSurge (rounded up from percentages) and available pods ≥ replicas − maxUnavailable (rounded down). Surge needs spare cluster capacity, otherwise extra pods sit Pending; maxUnavailable trades capacity for speed. 'Available' means Ready for at least minReadySeconds, so if pods need time after readiness to warm up, minReadySeconds stops the controller from removing old pods before the new ones can carry load.",
    rule: "With spare capacity, use maxUnavailable: 0 and as much maxSurge as fits; without it, size maxUnavailable to the headroom your peak allows. Set minReadySeconds to cover warm-up.",
    why: (I, sol) => { const r = rollSim(I, sol); return `The fastest safe choice is maxSurge ${sol.surge}, maxUnavailable ${sol.unav}${I.lv === 3 ? `, minReadySeconds ${sol.mrs}` : ""}: ${r.dur}s with at least ${r.minCap} capable pods.${I.lv === 3 ? ` Below ${I.warm}s of minReadySeconds, old pods are removed while new ones are still warming up.` : ""}`; },
  });

  /* ===== HPA behaviour (tune) ===== */
  function hpaSim(I, cfg) {
    const step = 15, T = 1800, cap = I.podRps, win = +cfg.win, target = +cfg.target / 100, minR = +(cfg.min || I.min);
    let pods = [];
    for (let k = 0; k < minR; k++) pods.push(-999);
    const recs = []; let events = 0, over = 0, podSec = 0, prev = minR;
    const load = (t) => I.base + (((t + I.phase) % I.every) < I.burstLen ? I.burst : 0);
    const series = [], cap_s = [];
    for (let t = 0; t < T; t += step) {
      const ready = pods.filter((s0) => t >= s0 + I.startup).length;
      const L = load(t);
      if (L > ready * cap) over += step;
      podSec += pods.length * step;
      const util = ready ? L / (ready * cap) : 9;
      let desired = Math.ceil(pods.length * util / target - 1e-9);
      if (Math.abs(util / target - 1) <= 0.1) desired = pods.length;
      desired = Math.max(minR, Math.min(I.max, desired));
      recs.push([t, desired]);
      let next = pods.length;
      if (desired > pods.length) next = Math.min(desired, Math.max(pods.length * 2, pods.length + 4));
      else { const inWin = recs.filter(([tt]) => tt > t - win - 1e-9).map((x) => x[1]); next = Math.max(...inWin, desired); next = Math.min(next, pods.length); }
      if (next > pods.length) for (let k = pods.length; k < next; k++) pods.push(t);
      if (next < pods.length) pods = pods.slice(0, next);
      if (next !== prev) events++;
      prev = next;
      series.push([t / 60, L]); cap_s.push([t / 60, ready * cap]);
    }
    return { over, events, cost: Math.round(podSec / 3600 * 10) / 10, series, cap_s };
  }
  MORE.push({
    id: "k8s-hpa-behavior", name: "Stop the HPA from flapping", kind: "Config change", skills: ["tune"], w: "tune", sense: "min", vname: "a cost of", vfmt: (x) => `${x} pod-hours`,
    gen(lv, R) {
      const I = { lv, app: pick(R, ["feed", "search", "notify"]), podRps: R.pick([80, 100, 120]), base: 0, max: 20, min: 2 };
      I.base = I.podRps * R.int(4, 6) * 0.6; I.burst = I.podRps * R.int(3, 5) * 0.6; I.every = R.pick([180, 240]); I.burstLen = R.pick([60, 75]); I.phase = R.int(0, 5) * 15;
      I.startup = lv === 3 ? R.pick([75, 90]) : 30;
      I.maxOver = lv === 1 ? 300 : lv === 2 ? 120 : 60; I.maxEvents = lv === 1 ? 12 : 8;
      return I;
    },
    text: (I) => `<p><b>${esc(I.app)}</b> autoscales on CPU. Its traffic has a steady base of ~${Math.round(I.base)} req/s with bursts of +${Math.round(I.burst)} req/s for ${I.burstLen}s every ${I.every / 60} minutes (a partner's batch sync). A pod handles about ${I.podRps} req/s at 100% CPU and needs <b>${I.startup}s</b> to become Ready. Right now the HPA scales up and down on every burst, and requests fail while new pods start.</p><p>Over a 30-minute replay, keep overload under <b>${I.maxOver}s</b> and replica changes at most <b>${I.maxEvents}</b>, as cheaply as possible.</p>`,
    ui: (I) => ({ knobs: [{ k: "win", label: "behavior.scaleDown.stabilizationWindowSeconds", opts: [0, 60, 300, 600], unit: "s" }, { k: "target", label: "target averageUtilization", opts: [50, 60, 70, 80], unit: "%" }, ...(I.lv > 1 ? [{ k: "min", label: "minReplicas", opts: [2, 3, 4, 6, 8] }] : [])], init: { win: 0, target: 80, min: 2 },
      live: (cfg) => { const r = hpaSim(I, cfg); return K.metrics([{ name: "Overloaded", value: `${r.over}s`, ok: r.over <= I.maxOver, target: `≤ ${I.maxOver}s` }, { name: "Replica changes", value: String(r.events), ok: r.events <= I.maxEvents, target: `≤ ${I.maxEvents}` }, { name: "Cost", value: `${r.cost} pod-h`, ok: null }]) + K.chart([{ name: "load (req/s)", pts: r.series, cls: "bad" }, { name: "ready capacity", pts: r.cap_s, cls: "good" }], { xlabel: "min", title: "Load vs ready capacity" }); } }),
    valid: (I, cfg) => { const r = hpaSim(I, cfg); if (r.over > I.maxOver) return `overloaded for ${r.over}s (limit ${I.maxOver}s)`; if (r.events > I.maxEvents) return `${r.events} replica changes (limit ${I.maxEvents})`; return true; },
    val: (I, cfg) => hpaSim(I, cfg).cost,
    hint: (I) => I.lv === 1 ? "Scale-down stabilization keeps the highest recommendation seen in the window. How long is the gap between bursts?" : I.lv === 2 ? "A lower target leaves headroom per pod; a higher floor absorbs bursts without waiting for new pods. Which is cheaper here?" : `New pods take ${I.startup}s to help, longer than most of a burst. Capacity has to be there before the burst starts.`,
    concept: "HPA behaviour and stabilization",
    how: "Every 15 s the HPA computes desired = ceil(current × utilization / target), ignoring changes within a 10% tolerance. Scale-up is immediate by default; scale-down uses a stabilization window (default 300 s) and picks the highest recommendation within it, which stops flapping on periodic bursts. Pods help only once Ready, so bursts shorter than startup time must be absorbed by headroom: a lower target utilization or a higher minReplicas.",
    rule: "Set the scale-down stabilization window longer than the gap between your bursts, and cover what's left with headroom (target or minReplicas), not faster reactions.",
    why: (I, sol) => { const r = hpaSim(I, sol); return `Window ${sol.win}s, target ${sol.target}%${sol.min ? `, minReplicas ${sol.min}` : ""}: ${r.over}s overloaded, ${r.events} replica changes, ${r.cost} pod-hours. A window shorter than the ${I.every}s burst cycle scales down between bursts and starts cold pods for every burst.`; },
  });

  /* ===== CPU limits and throttling (tune) ===== */
  function throttleSim(I, cfg) {
    const lim = cfg.limit === "none" ? Infinity : X().pCpu(String(cfg.limit)), req = X().pCpu(String(cfg.req));
    const procs = cfg.gmp === "unset" || cfg.gmp == null ? I.nodeCores : +cfg.gmp;
    const Q = lim * 0.1; // CPU-ms per 100 ms period
    const par = Math.min(procs, I.threads);
    const D = I.peakMs + 5 * procs; // peak-period demand: requests + GC workers (25% of GOMAXPROCS for ~20 ms)
    let wall = D / par;
    if (D > Q) { const periods = Math.ceil(D / Q); wall = (periods - 1) * 100 + (D - (periods - 1) * Q) / par; }
    const penalty = Math.max(0, wall - D / par);
    const p99 = Math.round(I.base + D / Math.min(par, lim === Infinity ? par : Math.max(1, lim / 1000)) * 0.15 + penalty);
    return { p99, throttled: D > Q, Q, D, req, lim };
  }
  MORE.push({
    id: "k8s-cpu-throttling", name: "Tame CPU throttling", kind: "Incident", skills: ["tune", "diagnose"], w: "tune", sense: "min", vname: "a CPU request of", vfmt: (x) => `${x}m`,
    gen(lv, R) {
      const I = { lv, app: pick(R, ["pricing", "gateway", "auth"]), base: R.int(18, 30), nodeCores: 32, threads: lv === 1 ? 8 : 64, use: R.pick([350, 420, 480]), peakMs: R.int(9, 14) * 10, target: 0 };
      I.target = lv === 1 ? 90 : 80;
      I.policy = lv > 1;
      return I;
    },
    text: (I) => `<p><b>${esc(I.app)}</b> (Go) averages <b>${I.use}m</b> CPU, but p99 latency is far above its <b>${I.target} ms</b> SLO while the dashboards show the pods "only 40% busy". <code>container_cpu_cfs_throttled_periods_total</code> is climbing. Requests arrive in bursts: the busiest 100 ms window needs about ${I.peakMs} ms of CPU, spread over up to ${I.threads} goroutines. Nodes have ${I.nodeCores} cores.${I.policy ? " Platform policy: every container must have a CPU limit (LimitRange), at most 4× its request." : ""}</p><p>Pick settings that meet the SLO without starving neighbours (request ≥ average use), with the smallest request.</p>`,
    ui: (I) => ({ knobs: [{ k: "req", label: "CPU request", opts: ["250m", "500m", "1", "2"] }, { k: "limit", label: "CPU limit", opts: I.policy ? ["500m", "1", "2", "4"] : ["500m", "1", "2", "4", "none"] }, ...(I.lv > 1 ? [{ k: "gmp", label: "GOMAXPROCS", opts: ["unset", 1, 2, 4, 8], help: "unset = Go sees all node cores" }] : [])], init: { req: "250m", limit: "500m", gmp: "unset" },
      live: (cfg) => { const r = throttleSim(I, cfg); return K.metrics([{ name: "CPU quota per 100 ms period", value: r.lim === Infinity ? "unlimited" : `${Math.round(r.Q)} ms`, ok: null }, { name: "Peak-period demand", value: `${Math.round(r.D)} ms`, ok: !r.throttled, target: r.throttled ? "over quota: throttled" : "fits" }, { name: "p99 latency", value: `${r.p99} ms`, ok: r.p99 <= I.target, target: `≤ ${I.target} ms` }]); } }),
    valid: (I, cfg) => { const r = throttleSim(I, cfg); if (r.req < I.use) return `the request (${cfg.req}) is below average use (${I.use}m): on a node packed by requests the pod competes for CPU it never reserved`; if (r.lim !== Infinity && r.lim < r.req) return "limit below request is invalid"; if (I.policy && r.lim > 4 * r.req) return "the LimitRange allows at most 4× the request"; return r.p99 <= I.target ? true : `p99 is ${r.p99} ms (SLO ${I.target} ms)${r.throttled ? ", the container is being throttled" : ""}`; },
    val: (I, cfg) => throttleSim(I, cfg).req,
    hint: (I) => I.lv === 1 ? "A limit of L cores is a quota of L×100 ms of CPU per 100 ms period, used up fast by many threads at once, after which the container waits for the next period." : "Go sizes its scheduler and GC workers by GOMAXPROCS, which defaults to the node's cores, not the container's limit.",
    concept: "CFS quota throttling",
    how: "A CPU limit becomes a CFS quota: limit × 100 ms of CPU time per 100 ms period. A multi-threaded process can burn its whole quota in a few milliseconds of wall time, then all its threads are paused until the next period, adding up to ~100 ms to whatever was in flight, even though average usage looks low. Runtimes that size thread pools from the node's core count (Go's GOMAXPROCS, JVM GC threads) make bursts worse. Requests, not limits, decide scheduling and the CPU share under contention.",
    rule: "Set CPU requests from real usage; prefer no CPU limit for latency-sensitive services, and if a limit is required, size it for bursts and set GOMAXPROCS (or equivalent) to match it.",
    why: (I, sol) => { const r = throttleSim(I, sol); return `With request ${sol.req}, limit ${sol.limit}${sol.gmp ? `, GOMAXPROCS ${sol.gmp}` : ""}, the peak period needs ${Math.round(r.D)} ms of CPU against ${r.lim === Infinity ? "no quota" : Math.round(r.Q) + " ms of quota"}, giving p99 ≈ ${r.p99} ms.${I.lv > 1 ? ` With GOMAXPROCS unset Go runs ${I.nodeCores} procs and its GC alone burns ~${5 * I.nodeCores} ms of quota per cycle.` : ""}`; },
  });

  /* ===== rightsizing from usage (tune) ===== */
  const RS_PRICE = { cpu: 22, mem: 3 }; // $ per core-month, per GiB-month
  function rsEval(I, cfg) {
    const out = { cost: 0, issues: [] };
    I.ctrs.forEach((c, k) => {
      const cpu = X().pCpu(String(cfg["cpu" + k])), mem = X().pMem(String(cfg["mem" + k]));
      out.cost += (cpu / 1000) * RS_PRICE.cpu + (mem / 1024) * RS_PRICE.mem;
      const memNeed = c.floor || c.mem.max;
      if (mem < memNeed) out.issues.push(`${c.name}: memory ${cfg["mem" + k]} < ${c.floor ? `heap + overhead (${X().memS(c.floor)})` : `observed max ${X().memS(c.mem.max)}`}: OOMKilled`);
      else if (mem < memNeed * 1.1) out.issues.push(`${c.name}: memory ${cfg["mem" + k]} leaves under 10% headroom over ${X().memS(memNeed)}`);
      if (cpu < c.cpu.p95) out.issues.push(`${c.name}: CPU request ${cfg["cpu" + k]} is below its p95 (${c.cpu.p95}m): starved whenever neighbours are busy`);
    });
    out.cost = Math.round(out.cost * 100) / 100;
    return out;
  }
  MORE.push({
    id: "k8s-rightsizing", name: "Rightsize from real usage", kind: "Capacity plan", skills: ["tune", "estimate"], w: "tune", sense: "min", vname: "a cost of", vfmt: (x) => `$${x}/month per pod`,
    gen(lv, R) {
      const mk = (name, cpu, mem, floor) => ({ name, cpu: { p50: Math.round(cpu * 0.5), p95: cpu, p99: Math.round(cpu * 1.5), max: Math.round(cpu * 3) }, mem: { p50: Math.round(mem * 0.8), p95: Math.round(mem * 0.95), max: mem }, floor });
      const app = pick(R, ["catalog", "orders", "ledger"]);
      if (lv === 1) return { lv, app, ctrs: [mk(app, R.pick([180, 220, 280]), R.pick([300, 360, 420]))], now: { cpu: "2", mem: "4Gi" } };
      if (lv === 2) { const heap = R.pick([768, 1024]); return { lv, app, heap, ctrs: [mk(app, R.pick([350, 420]), heap * 0.7 + 150, heap + 384)], now: { cpu: "2", mem: "4Gi" } }; }
      return { lv, app, ctrs: [mk(app, R.pick([400, 450]), R.pick([600, 700])), mk("istio-proxy", R.pick([60, 90]), R.pick([90, 110]))], now: { cpu: "2", mem: "4Gi" } };
    },
    text: (I) => `<p><b>${esc(I.app)}</b> was given requests of ${I.now.cpu} CPU / ${I.now.mem} "to be safe". Seven days of usage per pod (memory limit = request, no CPU limit):</p>${K.table(["Container", "CPU p50 / p95 / p99 / max", "Memory p50 / p95 / max"], I.ctrs.map((c) => [c.name, `${c.cpu.p50}m / ${c.cpu.p95}m / ${c.cpu.p99}m / ${c.cpu.max}m`, `${Math.round(c.mem.p50)}Mi / ${Math.round(c.mem.p95)}Mi / ${Math.round(c.mem.max)}Mi`]), { compact: true })}${I.lv === 2 ? `<p>It's a JVM started with <code>-Xmx${I.heap}m</code>; metaspace, threads and buffers add about 384 MiB on top of the heap. The heap hasn't filled up yet this week.</p>` : ""}<p>Pick requests that won't OOM (≥10% headroom over the true memory ceiling) and won't be starved (CPU ≥ p95), at the lowest cost ($${RS_PRICE.cpu}/core-month, $${RS_PRICE.mem}/GiB-month).</p>`,
    ui: (I) => ({ knobs: I.ctrs.flatMap((c, k) => [{ k: "cpu" + k, label: `${c.name} CPU request`, opts: ["100m", "150m", "250m", "350m", "500m", "750m", "1"], select: true }, { k: "mem" + k, label: `${c.name} memory request = limit`, opts: ["128Mi", "256Mi", "384Mi", "512Mi", "768Mi", "1Gi", "1280Mi", "1536Mi", "2Gi"], select: true }]), init: Object.fromEntries(I.ctrs.flatMap((c, k) => [["cpu" + k, "1"], ["mem" + k, "2Gi"]])),
      live: (cfg) => { const r = rsEval(I, cfg); return K.metrics([{ name: "Cost per pod", value: `$${r.cost}/mo`, ok: null, target: `was $${(2 * RS_PRICE.cpu + 4 * RS_PRICE.mem) * (I.ctrs.length === 2 ? 1 : 1)}` }]) + (r.issues.length ? K.note(r.issues.map(esc).join("<br>"), "bad") : K.verdict(true, "no OOM risk, no starvation")); } }),
    valid: (I, cfg) => { const r = rsEval(I, cfg); return r.issues.length ? r.issues[0] : true; },
    val: (I, cfg) => rsEval(I, cfg).cost,
    hint: (I) => I.lv === 1 ? "Memory isn't compressible: cover the maximum. CPU is: cover the p95 and let bursts borrow idle CPU." : I.lv === 2 ? "The observed max is not the JVM's ceiling. What will the heap grow to?" : "Rightsize each container separately; a sidecar's request counts too.",
    concept: "Rightsizing requests from usage",
    how: "Requests are what the scheduler reserves and what you pay for; usage is what the container actually needs. CPU is compressible, so a request around p90–p95 with no limit lets rare bursts borrow idle CPU; memory is not, so the memory limit must cover the true ceiling or the container is OOM-killed, and setting request = limit for memory avoids overcommitting nodes. For runtimes with a configured ceiling (JVM -Xmx, Go GOMEMLIMIT), the ceiling plus non-heap overhead matters more than this week's observed max. This is what the Vertical Pod Autoscaler's recommender automates.",
    rule: "CPU request ≈ p95 with no CPU limit; memory request = limit ≈ the true ceiling + 10–20%; re-check after every major release.",
    why: (I, sol) => { const r = rsEval(I, sol); return `${I.ctrs.map((c, k) => `${c.name}: ${sol["cpu" + k]} CPU, ${sol["mem" + k]}`).join("; ")}: $${r.cost} per pod per month instead of $${2 * RS_PRICE.cpu + 4 * RS_PRICE.mem}.${I.lv === 2 ? ` The JVM can grow its heap to ${I.heap} MiB plus ~384 MiB overhead, so sizing to this week's max would OOM later.` : ""}`; },
  });

  /* ===== Helm values precedence (tune, exact) ===== */
  MORE.push({
    id: "k8s-helm-values", name: "Predict the Helm values", kind: "Investigation", skills: ["diagnose"], w: "tune",
    gen(lv, R) {
      const I = { lv, rel: pick(R, ["checkout", "search", "orders"]), d: { rep: 1, tag: "1.0.0", mem: "256Mi" }, prod: { rep: R.pick([3, 4]), mem: R.pick(["512Mi", "768Mi"]) }, eu: { rep: R.pick([5, 6]) }, set: `2.${R.int(1, 9)}.${R.int(0, 9)}` };
      if (lv >= 2) { I.envProd = ["REGION=us", "CACHE=on"]; I.envEu = ["REGION=eu"]; }
      if (lv === 3) { I.set = `1.${pick(R, ["10", "20", "30"])}`; }
      return I;
    },
    text: (I) => {
      const files = [`# values.yaml (chart defaults)\nreplicaCount: 1\nimage:\n  repository: registry.corp.internal/${I.rel}\n  tag: "1.0.0"\nresources:\n  limits:\n    cpu: 500m\n    memory: 256Mi\n${I.lv >= 2 ? "env: []\n" : ""}`, `# values-prod.yaml\nreplicaCount: ${I.prod.rep}\nresources:\n  limits:\n    memory: ${I.prod.mem}\n${I.lv >= 2 ? `env:\n${I.envProd.map((e) => `  - ${e}`).join("\n")}\n` : ""}`, `# values-eu.yaml\nreplicaCount: ${I.eu.rep}\n${I.lv >= 2 ? `env:\n${I.envEu.map((e) => `  - ${e}`).join("\n")}\n` : ""}${I.lv === 3 ? "resources:\n  limits:\n    cpu: null\n" : ""}`];
      return `<p>The pipeline deploys <b>${esc(I.rel)}</b> with:</p>${K.pre(`helm upgrade --install ${I.rel} ./chart -f values-prod.yaml -f values-eu.yaml --set image.tag=${I.set}${I.lv === 1 ? "" : ""}`)}${K.pre(files.join("\n"))}<p>Predict the values the templates will see.</p>`;
    },
    ui: (I) => ({ knobs: [{ k: "rep", label: ".Values.replicaCount", opts: [1, I.prod.rep, I.eu.rep] }, { k: "tag", label: ".Values.image.tag", opts: [...new Set(["1.0.0", I.set, I.lv === 3 ? String(parseFloat(I.set)) : I.set + "-rc"])] }, { k: "mem", label: ".Values.resources.limits.memory", opts: ["256Mi", I.prod.mem] }, ...(I.lv >= 2 ? [{ k: "env", label: ".Values.env", opts: ["[]", JSON.stringify(I.envEu), JSON.stringify(I.envProd), JSON.stringify([...I.envProd, ...I.envEu])] }] : []), ...(I.lv === 3 ? [{ k: "cpu", label: ".Values.resources.limits.cpu", opts: ["500m", "(not set)", "null string"] }] : [])], init: {} }),
    ans: (I) => ({ rep: I.eu.rep, tag: I.lv === 3 ? String(parseFloat(I.set)) : I.set, mem: I.prod.mem, ...(I.lv >= 2 ? { env: JSON.stringify(I.envEu) } : {}), ...(I.lv === 3 ? { cpu: "(not set)" } : {}) }),
    diag: (I, a) => (a.rep !== I.eu.rep ? "Check replicaCount again: when several -f files set the same key, which one wins?" : a.mem !== I.prod.mem ? "Maps are merged key by key: does values-eu.yaml say anything about memory?" : I.lv >= 2 && a.env !== JSON.stringify(I.envEu) ? "Lists aren't merged." : "Not quite: look at how --set parses its value."),
    hint: (I) => I.lv === 1 ? "Precedence: chart defaults < -f files in order < --set." : I.lv === 2 ? "Maps are deep-merged; lists are replaced wholesale." : "--set infers types. What does YAML make of 1.10? And what does null do to a default?",
    concept: "Helm values precedence and merging",
    how: "Helm starts from the chart's values.yaml, then merges each -f file in order (later wins), then --set/--set-string flags (highest). Maps are merged key by key, so a later file only overrides the keys it mentions; lists and scalars are replaced wholesale. Setting a key to null removes the chart default. --set parses values with type inference, so <code>--set image.tag=1.10</code> becomes the number 1.1; use --set-string or quote it in a values file.",
    rule: "Keep environment overrides small, never rely on list merging, and pass versions with --set-string. Check with helm template or helm get values --all before trusting a deploy.",
    why: (I) => `replicaCount ${I.eu.rep} comes from the last -f file; memory ${I.prod.mem} survives because values-eu.yaml doesn't mention it (maps merge).${I.lv >= 2 ? ` env is ${esc(JSON.stringify(I.envEu))}: the eu list replaced the prod list.` : ""}${I.lv === 3 ? ` --set image.tag=${I.set} was parsed as the number ${parseFloat(I.set)}, and cpu: null deleted the chart's default limit.` : ` --set made the tag ${I.set}.`}`,
  });

  /* ===== cloud LB rollout: readiness gate + graceful termination (tune) ===== */
  function lbSim(I, cfg) {
    const gate = cfg.gate === "on", pre = +cfg.pre, grace = +cfg.grace;
    let t = 0, errors = [], lowest = I.n;
    const regAt = [];
    for (let k = 0; k < I.n; k++) {
      const ready = t + I.boot + (gate ? I.reg : 0);
      regAt.push(t + I.boot + I.reg);
      // old pod k is deleted when the new one is Ready
      const unregistered = regAt.filter((x) => x > ready).length;
      lowest = Math.min(lowest, I.n - unregistered);
      t = ready;
    }
    if (lowest < I.need) errors.push(`LB had only ${lowest} healthy targets during the rollout (need ${I.need}): 502/503s`);
    if (pre < I.prop) errors.push(`pods stopped accepting connections ${I.prop - pre}s before the LB stopped sending new requests: connection resets`);
    if (grace < pre + I.longest) errors.push(`terminationGracePeriodSeconds ${grace}s < preStop ${pre}s + longest request ${I.longest}s: SIGKILL cuts in-flight requests`);
    const dur = t + pre + I.longest;
    return { errors, dur, lowest };
  }
  MORE.push({
    id: "k8s-lb-rollout", name: "Zero-5xx deploys behind a cloud LB", kind: "Config change", skills: ["tune", "safe"], w: "tune", sense: "min", vname: "a rollout time of", vfmt: (x) => `${x}s`,
    gen(lv, R) {
      const n = lv === 1 ? 4 : 6;
      return { lv, n, need: lv === 1 ? 2 : n - 1, boot: R.pick([10, 15, 20]), reg: lv === 1 ? 5 : R.pick([30, 40, 50]), prop: R.pick([3, 5, 8]), longest: lv === 3 ? R.pick([40, 50]) : R.pick([5, 10]), app: pick(R, ["web", "api", "storefront"]) };
    },
    text: (I) => `<p><b>${esc(I.app)}</b> (${I.n} replicas, maxSurge 1 / maxUnavailable 0) sits behind a cloud load balancer that targets pod IPs directly. Each deploy shows a burst of 502s. Facts: pods pass readiness ${I.boot}s after start; the LB marks a new target healthy ${I.reg}s after registration; it takes up to ${I.prop}s after a pod starts terminating before the LB stops sending it new requests; the longest requests (${I.lv === 3 ? "file uploads" : "reports"}) take ${I.longest}s. At least <b>${I.need}</b> healthy LB targets are needed for peak traffic.</p><p>Find settings with no errors and the fastest rollout.</p>`,
    ui: (I) => ({ knobs: [{ k: "gate", label: "LB readiness gate (pod Ready waits for LB target health)", opts: ["off", "on"] }, { k: "pre", label: "preStop sleep", opts: [0, 5, 10, 20], unit: "s" }, { k: "grace", label: "terminationGracePeriodSeconds", opts: [30, 45, 60, 90], unit: "s" }], init: { gate: "off", pre: 0, grace: 30 },
      live: (cfg) => { const r = lbSim(I, cfg); return K.metrics([{ name: "Lowest healthy LB targets", value: String(r.lowest), ok: r.lowest >= I.need, target: `≥ ${I.need}` }, { name: "Rollout time", value: `${r.dur}s`, ok: null }]) + (r.errors.length ? K.note(r.errors.map(esc).join("<br>"), "bad") : K.verdict(true, "no 5xx during the rollout")); } }),
    valid: (I, cfg) => { const r = lbSim(I, cfg); return r.errors.length ? r.errors[0] : true; },
    val: (I, cfg) => lbSim(I, cfg).dur,
    hint: (I) => I.lv === 1 ? "When a pod is deleted, the kubelet and the endpoint/LB updates race. Something has to keep the pod serving until the LB lets go." : I.lv === 2 ? "Kubernetes considers the new pod Ready long before the LB does. What can make the rollout wait for the LB?" : "The grace period counts from the start of termination, preStop included.",
    concept: "Readiness gates and graceful termination",
    how: "On deletion the kubelet runs preStop and sends SIGTERM while, in parallel, the endpoint controller removes the pod and kube-proxy, ingress controllers and cloud LBs catch up seconds later; a preStop sleep covers that window. terminationGracePeriodSeconds counts from the start of termination, preStop included, after which the container is SIGKILLed. Cloud LBs that target pods directly add their own health-check delay; a pod readiness gate (for example the AWS Load Balancer Controller's target-health gate) keeps the pod not-Ready until the LB reports the target healthy, so the rollout doesn't remove old pods faster than the LB registers new ones.",
    rule: "preStop sleep ≥ endpoint propagation, grace period ≥ preStop + longest request, and a readiness gate whenever an external LB targets pods directly.",
    why: (I, sol) => { const r = lbSim(I, sol); return `Gate ${sol.gate}, preStop ${sol.pre}s, grace ${sol.grace}s: ${r.dur}s rollout with at least ${r.lowest} healthy targets.${I.reg > 10 ? ` Without the gate, each new pod counts as Ready ${I.reg}s before the LB uses it, so old pods are removed too early and healthy targets drain away.` : ""}`; },
  });

  /* ===== graceful shutdown race (interleave) ===== */
  const GR = {
    1: { lanes: [["kubelet", ["SIGTERM: app closes its listening socket", "app finishes in-flight requests and exits"]], ["control plane", ["EndpointSlice controller removes the pod", "kube-proxy on the client's node reprograms iptables"]], ["client pod", ["opens a new connection to the Service IP", "sends POST /checkout"]]] },
    2: { lanes: [["kubelet", ["preStop: sleep 10", "SIGTERM: app closes its listener (open connections stay)", "app exits"]], ["control plane", ["EndpointSlice controller removes the pod", "kube-proxy reprograms iptables"]], ["client pod (HTTP keep-alive pool)", ["opens a pooled connection to the Service IP", "request 1 on the pooled connection", "request 2 on the same pooled connection"]]] },
    3: { lanes: [["kubelet", ["preStop: sleep 10", "SIGTERM: app closes its listener", "app exits"]], ["control plane", ["EndpointSlice controller removes the pod", "kube-proxy reprograms iptables", "ingress-nginx updates its upstream list"]], ["browser via ingress-nginx", ["request reaches ingress-nginx, which picks an upstream pod IP", "ingress-nginx connects and forwards the request"]]] },
  };
  function grSim(lv, seq) {
    const L = GR[lv].lanes, pos = L.map(() => 0), log = [];
    const S = { listen: true, alive: true, routed: true, upstream: true, conn: null, picked: null, fail: null };
    for (const l of seq) {
      const k = pos[l]++, step = L[l][1][k];
      let note = "";
      if (l === 0) { if (/SIGTERM/.test(step)) { S.listen = false; note = "no new connections accepted"; } else if (/exits/.test(step)) { S.alive = false; note = lv === 1 ? "process gone" : "process gone; any connection still open is reset"; } else note = "pod keeps serving while it sleeps"; }
      else if (l === 1) { if (/EndpointSlice/.test(step)) note = "API updated; nodes haven't caught up yet"; else if (/iptables/.test(step)) { S.routed = false; note = "new connections now go to other pods"; } else { S.upstream = false; note = "nginx stops picking this pod"; } }
      else {
        if (lv === 3) {
          if (k === 0) { S.picked = S.upstream ? "pod" : "other"; note = S.picked === "pod" ? "picked the terminating pod" : "picked a healthy pod"; }
          else if (S.picked === "pod") { if (!S.alive || !S.listen) { S.fail = S.alive ? "502: connect() failed (111: Connection refused) while connecting to upstream" : "502: upstream gone"; note = S.fail; } else note = "200 OK"; } else note = "200 OK";
        } else if (k === 0) { S.conn = S.routed ? (S.listen && S.alive ? "pod" : "refused") : "other"; note = S.conn === "pod" ? "connected to the terminating pod" : S.conn === "other" ? "connected to a healthy pod" : "connection refused"; if (S.conn === "refused") S.fail = "connection refused"; }
        else if (!S.fail) { if (S.conn === "pod" && !S.alive) { S.fail = "connection reset by peer"; note = S.fail; } else note = "200 OK"; }
      }
      log.push({ l, step, note });
    }
    return { log, fail: S.fail };
  }
  MORE.push({
    id: "k8s-graceful-race", name: "Find the shutdown race", kind: "Investigation", skills: ["diagnose", "design"], w: "interleave",
    gen(lv, R) { return { lv, app: pick(R, ["checkout", "cart", "api"]), seed: R.int(1, 1e6) }; },
    text: (I) => I.lv === 1 ? `<p>Every deploy of <b>${esc(I.app)}</b> produces a few errors. The pod has no preStop hook. When a pod is deleted, the kubelet and the control plane react <i>in parallel</i>.</p><p>Find an ordering of these events in which the client's request fails.</p>`
      : I.lv === 2 ? `<p>You added <code>preStop: sleep 10</code> and errors dropped, but a service that calls <b>${esc(I.app)}</b> through an HTTP client with keep-alive connection pooling still sees errors on every deploy.</p><p>Find an ordering where its request fails.</p>`
        : `<p>Internal callers are clean now, but browsers going through <b>ingress-nginx</b> still get the odd 502 during deploys of <b>${esc(I.app)}</b>, even with the 10s preStop sleep. ingress-nginx sends traffic straight to pod IPs from its own upstream list.</p><p>Find an ordering where the browser gets a 502.</p>`,
    ui: (I) => ({ lanes: GR[I.lv].lanes.map(([name, steps]) => ({ name, steps })), live: (seq) => { const r = grSim(I.lv, seq || []); const L = GR[I.lv].lanes; return K.table(["#", ...L.map((x) => x[0])], r.log.map((e, k) => [String(k + 1), ...L.map((_, j) => (j === e.l ? `${esc(e.step)}<br><small class="${/refused|reset|502/.test(e.note) ? "lose" : "muted"}">${esc(e.note)}</small>` : ""))]), { compact: true }) + ((seq || []).length === L.reduce((a, x) => a + x[1].length, 0) ? K.verdict(!!r.fail, r.fail ? `request failed: ${esc(r.fail)}` : "every request succeeded") : ""); } }),
    accept: (I, seq) => (grSim(I.lv, seq).fail ? true : "Every request succeeded in that ordering. Which event has to come before which for the request to hit a closed or dead pod?"),
    solve: (I, spec) => { for (const sq of LB.byId.get("k8s-graceful-race").space(I, spec)) if (grSim(I.lv, sq).fail) return sq; return null; },
    bad: (I) => I.lv === 1 ? [[1, 1, 2, 2, 0, 0], [2, 2, 0, 0, 1, 1]] : I.lv === 2 ? [[1, 1, 2, 2, 2, 0, 0, 0], [2, 2, 2, 0, 0, 0, 1, 1]] : [[1, 1, 1, 2, 2, 0, 0, 0], [2, 2, 0, 0, 0, 1, 1, 1]],
    hint: (I) => I.lv === 1 ? "What if the app closes its socket before kube-proxy has stopped routing new connections to it?" : I.lv === 2 ? "iptables only decides where <i>new</i> connections go. Where does a pooled connection opened earlier go?" : "ingress-nginx doesn't use kube-proxy at all. Whose update does it wait for?",
    concept: "The endpoint-removal race",
    how: "Deleting a pod starts two independent chains: the kubelet runs preStop then sends SIGTERM, while the EndpointSlice controller removes the pod and every node's kube-proxy, every ingress controller and any external LB update their routing some time later. Nothing makes the second chain finish first. A preStop sleep keeps the app serving through that window. iptables rules only affect new connections, so long-lived keep-alive connections keep reaching the old pod: the app should close idle connections (Connection: close / GOAWAY) after SIGTERM and finish in-flight requests. Ingress controllers that route to pod IPs have their own, separate update delay.",
    rule: "preStop sleep longer than your slowest router's propagation, then on SIGTERM stop accepting, close idle keep-alive connections, drain in-flight requests, and exit before the grace period.",
    why: (I, sol) => { const r = grSim(I.lv, sol); return `In the reference ordering the request ended with <i>${esc(r.fail || "")}</i>. ${I.lv === 1 ? "SIGTERM closed the listener before kube-proxy stopped routing new connections to the pod. A preStop sleep delays SIGTERM past that window." : I.lv === 2 ? "The pooled connection was opened before iptables changed, so request 2 went to the old pod after it exited. The sleep can't help; the app must close idle connections on SIGTERM so clients reconnect." : "ingress-nginx still had the pod in its upstream list after the listener closed, because its own update lagged the 10s sleep. Make the sleep cover the ingress controller's propagation, or have the ingress retry idempotent requests on another upstream."}`; },
  });

  /* ===== CronJob / Job double processing (interleave) ===== */
  const CJ = {
    1: [["run 02:00 (concurrencyPolicy: Allow)", ["SELECT id FROM invoices WHERE status='due'", "charge the card for each selected invoice", "UPDATE invoices SET status='paid' WHERE id IN (selected)"]], ["run 02:15 (previous still running)", ["SELECT id FROM invoices WHERE status='due'", "charge the card for each selected invoice", "UPDATE invoices SET status='paid' WHERE id IN (selected)"]]],
    2: [["pod attempt 1 (node is lost mid-run)", ["claim: UPDATE invoices SET status='processing' WHERE status='due' RETURNING id", "charge the card for each claimed invoice", "(node lost: pod never marks them paid)"]], ["pod attempt 2 (Job retry, backoffLimit: 3)", ["reclaim: UPDATE ... SET status='processing' WHERE status IN ('due','processing') RETURNING id", "charge the card for each claimed invoice", "UPDATE invoices SET status='paid' WHERE id IN (claimed)"]]],
    3: [["run 02:00", ["SELECT id FROM invoices WHERE status='due'", "charge the card for each selected invoice", "UPDATE invoices SET status='paid' WHERE id IN (selected)"]], ["run 02:15 (concurrencyPolicy: Replace)", ["Replace: delete the running 02:00 Job (its pod gets SIGTERM)", "SELECT id FROM invoices WHERE status='due'", "charge the card for each selected invoice", "UPDATE invoices SET status='paid' WHERE id IN (selected)"]]],
  };
  function cjSim(lv, seq) {
    const L = CJ[lv], pos = L.map(() => 0), sel = [null, null], charged = [0, 0], log = [];
    let due = true, dead = [false, false], paid = false;
    for (const l of seq) {
      const k = pos[l]++, step = L[l][1][k];
      let note = "";
      if (dead[l]) note = "skipped: this run was killed";
      else if (/^Replace/.test(step)) { dead[0] = true; note = "02:00 run terminated mid-batch"; }
      else if (/^SELECT/.test(step)) { sel[l] = due && !paid; note = sel[l] ? "selects 418 invoices" : "selects nothing"; }
      else if (/^claim/.test(step)) { sel[l] = due; if (due) due = "processing"; note = sel[l] ? "claims 418 invoices" : "claims nothing"; }
      else if (/^reclaim/.test(step)) { sel[l] = !!due && !paid; note = sel[l] ? "claims 418 invoices (including stale 'processing' ones)" : "claims nothing"; }
      else if (/^charge/.test(step)) { if (sel[l]) { charged[l] = 1; note = "418 cards charged"; } else note = "nothing to charge"; }
      else if (/^UPDATE/.test(step)) { if (sel[l]) { paid = true; due = false; note = "marked paid"; } else note = "no rows"; }
      else note = "";
      log.push({ l, step, note });
    }
    const dbl = charged[0] + charged[1] > 1;
    return { log, dbl };
  }
  MORE.push({
    id: "k8s-cronjob-double-run", name: "Find the double charge", kind: "Investigation", skills: ["diagnose", "design"], w: "interleave",
    gen(lv, R) { return { lv, seed: R.int(1, 1e6), job: pick(R, ["invoice-charger", "payout-runner", "renewal-billing"]) }; },
    text: (I) => I.lv === 1 ? `<p>The <b>${esc(I.job)}</b> CronJob runs every 15 minutes with the default <code>concurrencyPolicy: Allow</code>. Month-end batches take longer than 15 minutes, and finance reports customers charged twice.</p><p>Find an interleaving of two runs that charges the same invoices twice.</p>`
      : I.lv === 2 ? `<p>After switching to <code>concurrencyPolicy: Forbid</code> and adding an atomic claim step, double charges still happen, about once a month, always after a node failure. The Job has <code>backoffLimit: 3</code>; a retry reclaims rows stuck in 'processing'.</p><p>Find the interleaving that charges twice.</p>`
        : `<p>Someone suggested <code>concurrencyPolicy: Replace</code> "so a slow run never overlaps the next one". Now double charges happen on long nights again.</p><p>Find the interleaving that charges twice.</p>`,
    ui: (I) => ({ lanes: CJ[I.lv].map(([name, steps]) => ({ name, steps })), live: (seq) => { const r = cjSim(I.lv, seq || []); const L = CJ[I.lv]; return K.table(["#", ...L.map((x) => x[0])], r.log.map((e, k) => [String(k + 1), ...L.map((_, j) => (j === e.l ? `<span class="mono">${esc(e.step)}</span><br><small class="muted">${esc(e.note)}</small>` : ""))]), { compact: true }) + ((seq || []).length === L.reduce((a, x) => a + x[1].length, 0) ? K.verdict(r.dbl, r.dbl ? "the same invoices were charged twice" : "each invoice charged once") : ""); } }),
    accept: (I, seq) => (cjSim(I.lv, seq).dbl ? true : "Each invoice was charged once in that ordering. Try letting the second run read the invoices before the first one marks them paid."),
    solve: (I, spec) => { for (const sq of LB.byId.get("k8s-cronjob-double-run").space(I, spec)) if (cjSim(I.lv, sq).dbl) return sq; return null; },
    bad: (I) => I.lv === 1 ? [[0, 0, 0, 1, 1, 1]] : I.lv === 2 ? [[1, 1, 1, 0, 0, 0]] : [[1, 0, 0, 0, 1, 1, 1], [1, 1, 1, 1, 0, 0, 0]],
    hint: (I) => I.lv === 1 ? "Both runs read the same 'due' rows if the second SELECT happens before the first UPDATE." : I.lv === 2 ? "The claim protects against concurrent runs, not against a retry of work that was half done." : "Replace kills the old run. What state does a killed run leave its batch in?",
    concept: "Jobs, retries and idempotency",
    how: "A CronJob's concurrencyPolicy only controls whether a new run starts while the previous Job is still active: Allow overlaps them, Forbid skips the new run, Replace deletes the running Job and starts a new one. None of them makes the work safe. Jobs retry failed pods up to backoffLimit, and a pod on a lost node can still be running while its replacement starts, so the same work may execute twice, and a killed run leaves side effects without the bookkeeping. External side effects such as card charges must be idempotent: use a stable idempotency key per invoice with the payment provider, and record the outcome in the same transaction as the state change where possible.",
    rule: "Assume every Job runs at least once, maybe twice, maybe partly. Make side effects idempotent (stable keys), use Forbid for long batch jobs, and never Replace work that can't be safely interrupted.",
    why: (I) => I.lv === 1 ? "Run 02:15 selected the same 'due' invoices before run 02:00 marked them paid, so both charged them. Forbid would stop the overlap, but the real fix is an idempotency key per invoice."
      : I.lv === 2 ? "Attempt 1 charged the cards and died before marking them paid; the retry reclaimed the stuck 'processing' rows and charged again. Only an idempotency key per invoice (so the provider returns the first charge) closes this hole."
        : "Replace killed the 02:00 run after it had charged but before it marked anything paid, so 02:15 found the same invoices still due and charged them again.",
  });

  /* ===== quorum placement (topo) ===== */
  function qpEval(I, a) {
    const chosen = (a && a.down) || [];
    const ns = chosen.map((k) => I.nodes[k]);
    const per = {}; ns.forEach((n) => (per[n.zone] = (per[n.zone] || 0) + 1));
    const q = Math.floor(I.k / 2) + 1;
    const zones = [...new Set(I.nodes.map((n) => n.zone))];
    const worstZone = Math.min(...zones.map((z) => I.k - (per[z] || 0)));
    const spot = ns.filter((n) => n.spot).length;
    const issues = [];
    if (ns.some((n) => n.full)) issues.push("a chosen node has no room");
    if (worstZone < q) issues.push(`losing one zone leaves ${worstZone} of ${I.k} replicas, below quorum (${q})`);
    if (I.spotMax != null && spot > I.spotMax) issues.push(`${spot} replicas on spot nodes; a spot reclaim wave can take them all at once`);
    if (I.lv === 3) { const worst = Math.min(...zones.map((z) => ns.filter((n) => n.zone !== z && !n.spot).length)); if (worst < q) issues.push(`a zone outage during a spot reclaim leaves only ${worst} replicas`); }
    const cost = ns.reduce((s0, n) => s0 + n.cost, 0);
    return { issues, cost, per, spot };
  }
  MORE.push({
    id: "k8s-quorum-placement", name: "Place the quorum replicas", kind: "Design review", skills: ["design", "safe"], w: "topo", sense: "min", vname: "a cost of", vfmt: (x) => `$${x}/month`,
    gen(lv, R) {
      const zones = ["1a", "1b", "1c"];
      const per = lv === 1 ? 2 : 3;
      const nodes = [];
      zones.forEach((z, zi) => { for (let k = 0; k < per; k++) { const spot = lv > 1 && k === per - 1; const full = lv > 1 && k === 0 && zi === R.int(0, 2); nodes.push({ zone: z, spot, full, cost: spot ? R.int(40, 60) : R.int(110, 160), label: `${z}-${k + 1}`, x: 110 + zi * 210, y: 60 + k * 80 }); } });
      return { lv, k: lv === 1 ? 3 : 5, nodes, spotMax: lv === 1 ? null : 1, store: pick(R, ["etcd", "ZooKeeper", "a Raft-based config store"]) };
    },
    text: (I) => `<p>You're placing <b>${I.k}</b> replicas of ${esc(I.store)} (majority quorum: ${Math.floor(I.k / 2) + 1}) on the nodes below, one replica per node. It must keep quorum through the loss of any single zone${I.lv > 1 ? `, and at most ${I.spotMax} replica may sit on a spot node (spot capacity is reclaimed in waves)` : ""}${I.lv === 3 ? ", and it must keep quorum even if a zone fails during a spot reclaim" : ""}. Nodes marked full have no room.</p><p>Pick the ${I.k} nodes with the lowest monthly cost.</p>`,
    ui: (I) => ({ nodes: I.nodes.map((n) => ({ label: n.label, sub: `${n.spot ? "spot · " : ""}$${n.cost}${n.full ? " · full" : ""}`, x: n.x, y: n.y, fixed: n.full, cls: n.spot ? "warn" : "" })), links: [], mode: "nodes", k: I.k, nodeVerb: "chosen", W: 640, H: I.lv === 1 ? 200 : 280, aria: "Nodes by zone",
      live: (a) => { if (!a || !(a.down || []).length) return ""; const r = qpEval(I, a); return K.metrics([{ name: "Replicas per zone", value: ["1a", "1b", "1c"].map((z) => r.per[z] || 0).join(" / "), ok: null }, { name: "Monthly cost", value: `$${r.cost}`, ok: null }]) + (r.issues.length ? K.note(r.issues.map(esc).join("<br>"), "bad") : (a.down || []).length === I.k ? K.verdict(true, "survives the failures it must") : ""); } }),
    valid: (I, a) => { const r = qpEval(I, a); return r.issues.length ? r.issues[0] : true; },
    val: (I, a) => qpEval(I, a).cost,
    hint: (I) => I.lv === 1 ? "Two replicas in one zone means a single zone outage takes two out of three." : I.lv === 2 ? `With ${I.k} replicas, how many may share a zone? Spot is cheap, but how much of it can you afford to lose at once?` : "Count what's left after removing one zone and every spot node together.",
    concept: "Failure domains and quorum",
    how: "A majority-quorum system with n replicas survives losing n − (n/2 + 1) of them at once. Replicas that share a failure domain (node, zone, spot pool, rack) fail together, so the placement must cap replicas per domain: for 5 replicas across 3 zones, at most 2 per zone. Correlated domains combine: a zone outage during a spot reclaim wave removes both sets at once. Topology spread constraints and anti-affinity encode these caps in the pod spec.",
    rule: "For quorum systems, count the worst combination of correlated failures you must survive, cap replicas per failure domain accordingly, and only then optimise cost.",
    why: (I, sol) => { const r = qpEval(I, sol); return `${["1a", "1b", "1c"].map((z) => `${z}: ${r.per[z] || 0}`).join(", ")} with ${r.spot} on spot, $${r.cost}/month. ${I.lv === 1 ? "One per zone means any zone outage leaves 2 of 3." : `No zone holds more than ${I.k - (Math.floor(I.k / 2) + 1)}, so any zone outage leaves a quorum${I.lv === 3 ? ", even with the spot replica gone too" : ""}.`}`; },
  });

  /* ===== QoS classes (classify) ===== */
  const QOS_ITEMS = {
    1: [["requests cpu 500m / memory 1Gi; limits cpu 500m / memory 1Gi", 0], ["requests cpu 250m / memory 512Mi; limits memory 512Mi", 1], ["no resources at all", 2], ["limits cpu 1 / memory 2Gi only (no requests)", 0], ["requests cpu 100m only", 1]],
    2: [["app: requests = limits (cpu 1, memory 2Gi); sidecar: no resources", 1], ["app and sidecar both requests = limits for cpu and memory", 0], ["requests memory 1Gi = limit; requests cpu 500m, limit cpu 1", 1], ["init container: no resources; app: requests = limits", 1], ["limits only on both containers, for cpu and memory", 0], ["requests cpu 0 / memory 0 (explicit zeros)", 1]],
    3: [["no resources; namespace LimitRange sets defaultRequest = default (cpu 500m, memory 512Mi)", 0], ["no resources; LimitRange defaultRequest memory 256Mi, default memory 512Mi", 1], ["requests = limits, plus a native sidecar (restartPolicy: Always) with requests only", 1], ["ephemeral-storage requests/limits only", 2], ["requests = limits for cpu and memory, plus ephemeral-storage request only", 0], ["limits cpu 2 / memory 4Gi; requests memory 4Gi", 0]],
  };
  MORE.push({
    id: "k8s-qos-classes", name: "Classify the QoS classes", kind: "Investigation", skills: ["diagnose"], w: "classify",
    gen(lv, R) { const its = R.shuffle(QOS_ITEMS[lv].map((x) => x.slice())); return { lv, items: its }; },
    text: (I) => `<p>Before tightening node memory, you audit which pods would be evicted first. Classify each pod's QoS class as Kubernetes computes it (shown in <code>kubectl describe pod</code>).${I.lv === 3 ? " Remember admission runs before QoS is computed." : ""}</p>`,
    ui: (I) => ({ items: I.items.map((x) => x[0]), cats: ["Guaranteed", "Burstable", "BestEffort"] }),
    ans: (I) => I.items.map((x) => x[1]),
    diag: (I, a) => { const w = I.items.findIndex((x, k) => a[k] !== x[1]); return `Look again at “${esc(I.items[w][0])}”.`; },
    hint: (I) => I.lv === 1 ? "If only limits are set, requests default to the limits." : I.lv === 2 ? "QoS is per pod: every container (init containers too) must have equal CPU and memory requests and limits for Guaranteed." : "LimitRange defaults are applied at admission, before QoS is computed. Only CPU and memory count.",
    concept: "Pod QoS classes",
    how: "QoS is computed per pod from CPU and memory only. <b>Guaranteed</b>: every container, init and sidecar containers included, has CPU and memory limits, and requests equal to them (requests default to limits if omitted). <b>BestEffort</b>: no container has any CPU or memory request or limit. Everything else is <b>Burstable</b>. LimitRange defaults are filled in at admission, so they count. Under node memory pressure BestEffort and over-request Burstable pods are evicted first, and the kernel's OOM score favours killing them too.",
    rule: "Give critical pods (and all their sidecars) requests = limits for memory and CPU if you want Guaranteed; know that a single sidecar without resources demotes the whole pod.",
    why: (I) => `${I.items.map((x) => `${esc(x[0])} → <b>${["Guaranteed", "Burstable", "BestEffort"][x[1]]}</b>`).join("; ")}.`,
  });

  /* ===== what triggers a rollout (classify) ===== */
  const RO_ITEMS = {
    1: [["change the container image tag", 0], ["kubectl scale --replicas=8", 1], ["edit a ConfigMap the pods read via envFrom", 1], ["add an annotation under spec.template.metadata", 0], ["add a label to the Deployment's own metadata", 1]],
    2: [["kubectl set resources (raise the memory limit)", 0], ["change strategy.rollingUpdate.maxSurge", 1], ["change the HPA's minReplicas", 1], ["kubectl rollout restart", 0], ["change the Service's selector", 1], ["add an environment variable", 0]],
    3: [["change a literal in a kustomize configMapGenerator", 0], ["change a ConfigMap in a Helm chart whose Deployment has a checksum/config annotation of that ConfigMap", 0], ["rotate a Secret the pods read with secretKeyRef", 1], ["change revisionHistoryLimit", 1], ["change minReadySeconds", 1], ["change spec.template.spec.terminationGracePeriodSeconds", 0]],
  };
  MORE.push({
    id: "k8s-what-rolls", name: "Which changes roll the pods?", kind: "Change plan", skills: ["safe"], w: "classify",
    gen(lv, R) { return { lv, items: R.shuffle(RO_ITEMS[lv].map((x) => x.slice())) }; },
    text: (I) => `<p>Your change-management bot needs to know which changes to a Deployment-based service start a <b>new rollout</b> (new ReplicaSet, pods replaced) and which don't. Classify each change.</p>`,
    ui: (I) => ({ items: I.items.map((x) => x[0]), cats: ["New rollout", "No rollout"] }),
    ans: (I) => I.items.map((x) => x[1]),
    diag: (I, a) => { const w = I.items.findIndex((x, k) => a[k] !== x[1]); return `Look again at “${esc(I.items[w][0])}”: does it change the pod template?`; },
    hint: () => "Only a change to spec.template (the pod template) creates a new ReplicaSet. Ask of each change: does it end up in the template?",
    concept: "Pod template hash and rollouts",
    how: "A Deployment hashes its pod template (spec.template) into the pod-template-hash label; any change to the template creates a new ReplicaSet and a rolling update, and nothing else does. Scaling, strategy, minReadySeconds, revisionHistoryLimit, HPAs and Services live outside the template. ConfigMaps and Secrets are separate objects, so editing one doesn't touch the template; that's why kustomize's configMapGenerator (hashed names) and Helm's checksum annotation pattern exist: they put a fingerprint of the config into the template. <code>kubectl rollout restart</code> works by setting a restartedAt annotation in the template.",
    rule: "If you want a config change to roll pods, make it change the pod template (hashed ConfigMap names or checksum annotations); if you don't, keep it out of the template.",
    why: (I) => `${I.items.map((x) => `${esc(x[0])}: <b>${x[1] ? "no rollout" : "rollout"}</b>`).join("; ")}.`,
  });

  /* ===== eviction order under memory pressure (order) ===== */
  function evOrder(I) {
    return I.pods.map((p, k) => k).sort((a, b) => {
      const A = I.pods[a], B = I.pods[b];
      const ea = A.use > A.req ? 1 : 0, eb = B.use > B.req ? 1 : 0;
      if (ea !== eb) return eb - ea;
      if (A.prio !== B.prio) return A.prio - B.prio;
      return (B.use - B.req) - (A.use - A.req);
    });
  }
  MORE.push({
    id: "k8s-eviction-order", name: "Predict the eviction order", kind: "Investigation", skills: ["diagnose"], w: "order",
    gen(lv, R) {
      const names = R.shuffle(["batch-etl", "api", "cache", "log-agent", "search", "report-gen", "ml-scorer"]);
      const n = lv === 1 ? 4 : 5;
      const pods = [];
      for (let k = 0; k < n; k++) {
        const req = lv === 1 && k === 0 ? 0 : R.pick([256, 512, 1024, 2048]);
        const over = lv === 1 ? k < 2 : R.chance(0.5);
        const use = over ? req + R.pick([128, 384, 768, 1536]) : Math.max(64, req - R.pick([64, 128, 200]));
        pods.push({ name: names[k], req, use, prio: lv === 1 ? 0 : R.pick([0, 1000, 100000]) });
      }
      const I = { lv, pods };
      const ord = evOrder(I), keys = ord.map((k) => `${pods[k].use > pods[k].req}|${pods[k].prio}|${pods[k].use - pods[k].req}`);
      if (new Set(keys).size !== keys.length) return null;
      if (lv > 1 && new Set(pods.map((p) => p.prio)).size < 2) return null;
      if (lv === 3 && !pods.some((a) => a.use > a.req && pods.some((b) => b.use <= b.req && a.prio > b.prio))) return null;
      return I;
    },
    text: (I) => `<p>A node hits its memory eviction threshold. The kubelet will evict pods one at a time until pressure clears. Put these pods in the order the kubelet would pick them:</p>${K.table(["Pod", "Memory request", "Memory usage", ...(I.lv > 1 ? ["Priority"] : [])], I.pods.map((p) => [p.name, p.req ? `${p.req}Mi` : "none (BestEffort)", `${p.use}Mi`, ...(I.lv > 1 ? [String(p.prio)] : [])]), { compact: true })}`,
    ui: (I) => ({ items: I.pods.map((p) => p.name) }),
    ans: (I) => evOrder(I),
    diag: () => "Not quite. The kubelet's ranking has three keys, applied in a fixed order.",
    hint: (I) => I.lv === 1 ? "First: is the pod using more than it requested?" : "Three keys in order: usage above request (yes first), then priority (lower first), then how far above its request it is.",
    concept: "Node-pressure eviction ranking",
    how: "When a node crosses a memory eviction threshold, the kubelet ranks pods by: first, whether their memory usage exceeds their request; then by Pod Priority (lower first); then by usage relative to request (furthest over first). BestEffort pods have a zero request, so any usage counts as over. A high-priority pod that exceeds its request is evicted before a low-priority pod staying within its request. This is the kubelet's eviction, separate from the kernel OOM killer, which acts when a container hits its own limit or the node runs out before the kubelet reacts.",
    rule: "The best protection against eviction is a memory request that covers real usage. Priority only matters among pods on the same side of that line.",
    why: (I) => `Order: ${evOrder(I).map((k) => { const p = I.pods[k]; return `${esc(p.name)} (${p.use > p.req ? `${p.use - p.req}Mi over` : "within request"}${I.lv > 1 ? `, priority ${p.prio}` : ""})`; }).join(" → ")}.`,
  });

  /* ===== secret rotation plan (steps) ===== */
  const ROT = {
    A: "Create a second DB user (app_v2) with a new password, alongside the old one",
    B: "Update the Secret db-creds to app_v2's credentials",
    C: "kubectl rollout restart the Deployment that reads db-creds",
    D: "Verify in pg_stat_activity that every connection now uses app_v2",
    E: "Revoke the old user's login",
    F: "Change the old user's password in place (ALTER USER app PASSWORD ...)",
    G: "Wait ~2 minutes for the kubelet to sync the mounted Secret",
    H: "Delete all the Deployment's pods at once so they pick up the change",
    J: "Check that no CronJob pod started before the Secret change is still running",
  };
  const ROT_KEYS = { 1: ["A", "B", "C", "D", "E", "F", "G", "H"], 2: ["A", "B", "C", "D", "E", "F", "G", "H"], 3: ["A", "B", "C", "D", "E", "F", "G", "J"] };
  function rotSim(I, seq) {
    const keys = ROT_KEYS[I.lv], S = { ok: { old: true, neu: false }, secret: "old", dep: "old", cronOld: I.lv === 3, verified: false, log: [] };
    const vol = I.lv >= 2;
    for (const k of seq.map((x) => keys[x])) {
      const err = (m) => ({ err: `Step “${ROT[k]}”: ${m}`, S });
      if (k === "A") S.ok.neu = true;
      else if (k === "B") S.secret = "neu";
      else if (k === "C") { if (!S.ok[S.secret]) return err("the restarted pods log in with credentials the database doesn't accept: outage."); S.dep = S.secret; }
      else if (k === "G") { if (!vol) return err("the pods read the password from an environment variable, which never changes after the container starts. Waiting does nothing."); if (S.secret === "neu") { if (!S.ok.neu) return err("the app now uses a user that doesn't exist yet."); S.dep = "neu"; } }
      else if (k === "D") { if (S.dep !== "neu" || (I.lv === 3 && S.cronOld)) return err("verification would show connections still using the old user; the plan isn't finished at this point."); S.verified = true; }
      else if (k === "J") S.cronOld = false;
      else if (k === "E") { if (S.dep === "old" || S.cronOld) return err("something still logs in as the old user: outage."); if (!S.verified) return err("you revoke without having verified that nothing uses the old user."); S.ok.old = false; }
      else if (k === "F") return err("every pod still holding the old password fails its next new connection the moment you change it: outage.");
      else if (k === "H") return err("deleting every pod at once takes the whole service down until replacements are Ready.");
    }
    if (S.ok.old) return { err: "The old credential is never revoked, so the rotation isn't done." };
    return { ok: true, S };
  }
  MORE.push({
    id: "k8s-secret-rotation", name: "Rotate the database password", kind: "Change plan", skills: ["safe", "comms"], w: "steps",
    gen(lv, R) { const keys = ROT_KEYS[lv]; return { lv, app: pick(R, ["orders", "billing", "ledger"]), order: R.shuffle(keys.map((_, k) => k)) }; },
    text: (I) => `<p>Security wants the <b>${esc(I.app)}</b> database password rotated today, with zero downtime. ${I.lv === 1 ? "The Deployment reads it from the Secret <code>db-creds</code> as an <b>environment variable</b> (secretKeyRef)." : I.lv === 2 ? "The Deployment mounts the Secret <code>db-creds</code> as a <b>volume</b> (no subPath) and re-reads the file for every new DB connection." : "The Deployment mounts <code>db-creds</code> as a volume and re-reads it per connection. A nightly CronJob reads the same Secret as an <b>environment variable</b>; tonight's run started an hour ago and is still going."}</p><p>Build the plan, in order. Not every step belongs in it.</p>`,
    ui: (I) => ({ opts: I.order.map((k) => ROT[ROT_KEYS[I.lv][k]]), live: (seq) => { if (!seq || !seq.length) return ""; const r = rotSim(I, seq.map((x) => I.order[x])); return r.ok ? K.verdict(true, "rotation complete, no failed logins") : K.note(esc(r.err), /isn't done|isn't finished/.test(r.err) ? "" : "bad"); } }),
    accept(I, seq) { const r = rotSim(I, seq.map((x) => I.order[x])); return r.ok ? true : esc(r.err); },
    solve: (I) => { const want = I.lv === 1 ? "ABCDE" : I.lv === 2 ? "ABGDE" : "ABGJDE"; return [...want].map((k) => I.order.indexOf(ROT_KEYS[I.lv].indexOf(k))); },
    bad: (I) => { const m = (w) => [...w].map((k) => I.order.indexOf(ROT_KEYS[I.lv].indexOf(k))); return I.lv === 1 ? [m("ABGDE"), m("FC"), m("ABCE")] : I.lv === 2 ? [m("ABE"), m("ABHDE")] : [m("ABGDE"), m("ABCDE")]; },
    hint: (I) => I.lv === 1 ? "Two valid credentials must overlap: add the new one, move everyone over, check, then remove the old one." : I.lv === 2 ? "Mounted Secrets (without subPath) are updated in place by the kubelet after a short delay." : "Each consumer picks up the change its own way. Which one only sees it when a new pod starts?",
    concept: "Zero-downtime credential rotation",
    how: "A rotation needs a window where both the old and the new credential are valid: create the new one, switch every consumer, verify nothing uses the old one, then revoke it. How a pod picks up a changed Secret depends on how it consumes it: environment variables are fixed at container start (only a new pod sees the change), mounted volumes are updated in place by the kubelet within its sync period (subPath mounts never), and the application must re-read the file. Long-running Job pods keep whatever they started with.",
    rule: "Rotate with overlap (dual credentials), roll or wait per consumer type, verify with the database's own view of sessions, and revoke last.",
    why: (I) => I.lv === 1 ? "Env vars only change in new containers, so a rolling restart moves pods to app_v2 without downtime; you verify, then revoke. Changing the password in place would have broken every pod's next connection."
      : I.lv === 2 ? "The kubelet updates the mounted file within a couple of minutes and the app re-reads it per connection, so no restart is needed; just wait, verify and revoke."
        : "The Deployment follows the mounted Secret, but the CronJob pod that started an hour ago still holds the old password in its environment. Revoking before it finishes would fail its next connection.",
  });

  /* ===== cluster upgrade plan (steps) ===== */
  const UP = (I) => {
    const v = (m) => `1.${m}`;
    const o = [
      ["scan", `Scan manifests, Helm releases and live objects for APIs removed by ${v(I.to)} and migrate them`],
      ["addons-check", "Check CNI, CSI driver, ingress controller and cluster-autoscaler compatibility with the target version"],
      ["cp1", `Upgrade the control plane ${v(I.from)} → ${v(I.from + 1)}`],
      ["nodes", `Upgrade node pools to ${v(I.to)} by surge-replacing nodes (new nodes first, then drain old ones respecting PDBs)`],
      ["addons", "Upgrade add-ons to the versions matching the new control plane"],
      ["nodes-first", `Upgrade node pools to ${v(I.to)} first, then the control plane`],
      ["drain-all", "Drain all old nodes at once to finish faster"],
      ["no-pdb", "Delete PodDisruptionBudgets for the duration so drains don't block"],
    ];
    if (I.to - I.from === 2) { o.splice(3, 0, ["cp2", `Upgrade the control plane ${v(I.from + 1)} → ${v(I.to)}`]); o.push(["skip", `Upgrade the control plane directly ${v(I.from)} → ${v(I.to)}`], ["nodes-mid", `Upgrade node pools to ${v(I.from + 1)}`]); }
    return o;
  };
  function upSim(I, keys) {
    const S = { cp: I.from, nodes: I.from, scan: false, check: false, addons: false };
    for (const k of keys) {
      const err = (m) => ({ err: m });
      if (k === "scan") S.scan = true;
      else if (k === "addons-check") S.check = true;
      else if (k === "cp1" || k === "cp2" || k === "skip") {
        if (k === "skip") return err("The control plane can only be upgraded one minor version at a time.");
        if (k === "cp2" && S.cp !== I.from + 1) return err("That upgrade starts from a version the control plane isn't on yet.");
        if (k === "cp1" && S.cp !== I.from) return err("The control plane is already past that version.");
        if (!S.scan) return err(`Upgrading the API server before migrating removed APIs: manifests using them stop applying and Helm upgrades fail.`);
        if (I.lv >= 2 && !S.check) return err("Upgrading the control plane without checking add-on compatibility: an incompatible CNI or CSI driver can break networking or volumes cluster-wide.");
        S.cp++;
      } else if (k === "nodes" || k === "nodes-mid") {
        const tgt = k === "nodes" ? I.to : I.from + 1;
        if (tgt > S.cp) return err("Nodes can't run a newer kubelet than the API server.");
        S.nodes = tgt;
      } else if (k === "addons") { if (S.cp !== I.to) return err("Add-on versions are matched to the control plane; upgrade them after it."); S.addons = true; }
      else if (k === "nodes-first") return err("A kubelet must never be newer than the API server: control plane first, nodes after.");
      else if (k === "drain-all") return err("Draining every node at once evicts everything simultaneously and ignores the capacity you need for rescheduling.");
      else if (k === "no-pdb") return err("Deleting PDBs removes exactly the protection a node roll needs.");
    }
    if (S.cp !== I.to || S.nodes !== I.to) return { err: `The cluster ends at control plane 1.${S.cp}, nodes 1.${S.nodes}; target is 1.${I.to} everywhere.`, partial: true };
    if (I.lv >= 2 && !S.addons) return { err: "Add-ons are still on versions for the old control plane.", partial: true };
    return { ok: true };
  }
  MORE.push({
    id: "k8s-cluster-upgrade", name: "Plan the cluster upgrade", kind: "Change plan", skills: ["safe", "comms"], w: "steps",
    gen(lv, R) { const from = R.pick([29, 30, 31]); const to = lv === 2 ? from + 2 : from + 1; const I = { lv, from, to }; I.order = R.shuffle(UP(I).map((_, k) => k)); return I; },
    text: (I) => `<p>Your production cluster runs Kubernetes <b>1.${I.from}</b> (control plane and nodes) and must move to <b>1.${I.to}</b> before the provider's end-of-support date.${I.lv === 2 ? " You want as few node rolls as possible: each one takes a day." : ""}${I.lv === 3 ? " It runs a self-managed CNI and CSI driver, and teams own PDBs on their workloads." : ""}</p><p>Order the plan. Leave out steps that don't belong.</p>`,
    ui: (I) => { const o = UP(I); return { opts: I.order.map((k) => o[k][1]), live: (seq) => { if (!seq || !seq.length) return ""; const r = upSim(I, seq.map((x) => o[I.order[x]][0])); return r.ok ? K.verdict(true, `cluster on 1.${I.to}, no version-skew violations`) : K.note(esc(r.err), r.partial ? "" : "bad"); } }; },
    accept(I, seq) { const o = UP(I), r = upSim(I, seq.map((x) => o[I.order[x]][0])); return r.ok ? true : esc(r.err); },
    solve: (I) => { const o = UP(I).map((x) => x[0]); const want = I.lv === 1 ? ["scan", "cp1", "nodes"] : I.lv === 2 ? ["scan", "addons-check", "cp1", "cp2", "nodes", "addons"] : ["scan", "addons-check", "cp1", "nodes", "addons"]; return want.map((k) => I.order.indexOf(o.indexOf(k))); },
    bad: (I) => { const o = UP(I).map((x) => x[0]); const m = (w) => w.map((k) => I.order.indexOf(o.indexOf(k))); return I.lv === 1 ? [m(["nodes-first", "cp1"]), m(["cp1", "nodes"])] : I.lv === 2 ? [m(["scan", "addons-check", "skip", "nodes", "addons"]), m(["scan", "addons-check", "cp1", "nodes", "cp2", "addons"])] : [m(["scan", "cp1", "nodes", "addons"]), m(["scan", "addons-check", "cp1", "no-pdb", "nodes", "addons"])]; },
    hint: (I) => I.lv === 1 ? "Which component may be older than which? And what stops working the moment the API server stops serving an API version?" : I.lv === 2 ? "The control plane moves one minor at a time, but kubelets may lag the API server by up to three minors." : "Add-ons that run on every node are coupled to the control plane version too.",
    concept: "Version skew and upgrade order",
    how: "The supported skew policy: kube-apiserver is upgraded first and only one minor version at a time; kubelets may be up to three minor versions older than the API server (since 1.28) but never newer. Removed API versions stop being served the moment the API server is upgraded, so manifests, Helm releases and controllers using them must be migrated first. Node pools are best upgraded by surge replacement with drains that respect PDBs. Add-ons like the CNI, CSI drivers, ingress controllers and cluster-autoscaler have their own compatibility matrices.",
    rule: "Scan for removed APIs and check add-ons, upgrade the control plane one minor at a time, then roll nodes (possibly once for several control-plane steps), then upgrade add-ons. Never delete PDBs to speed things up.",
    why: (I) => I.lv === 1 ? "Removed APIs first, then the control plane, then the nodes: kubelets may be older than the API server, never newer."
      : I.lv === 2 ? `The control plane must pass through 1.${I.from + 1}, but nodes on 1.${I.from} are within the three-minor kubelet skew of 1.${I.to}, so a single node roll straight to 1.${I.to} saves a whole day.`
        : "With self-managed CNI and CSI, compatibility is checked before touching the control plane and the add-ons are upgraded right after; nodes roll with drains that respect every team's PDB.",
  });

  /* ===== who is in the EndpointSlice (select) ===== */
  const EP_POOL = {
    1: [["Running, 1/1 ready", true], ["Running, 0/1 ready (readiness probe failing)", false], ["CrashLoopBackOff, 0/1", false], ["Running 1/1 ready, but label app=web-canary (selector is app=web)", false], ["Running, 2/2 ready (app + sidecar)", true], ["Running, 1/2 ready (sidecar not ready)", false]],
    2: [["Running, containers 1/1 ready, readiness gate target-health.elbv2.k8s.aws = True", true], ["Running, containers 1/1 ready, readiness gate target-health.elbv2.k8s.aws = False", false], ["Terminating (preStop sleeping), readiness probe still passing", false], ["Running, 1/1 ready, no readiness gates", true], ["Running, 0/1 ready, readiness gate = True", false], ["Running, 1/1 ready, readiness gate condition not yet reported", false]],
    3: [["Running, 0/1 ready (still syncing data)", true], ["Pending (not scheduled, no IP)", false], ["Running, 1/1 ready", true], ["Terminating, readiness probe failing", true], ["Running, 1/1 ready, but label app=kafka-old (selector is app=kafka)", false], ["ContainerCreating (IP assigned, container not started)", true]],
  };
  MORE.push({
    id: "k8s-endpoints-ready", name: "Who gets traffic right now?", kind: "Investigation", skills: ["diagnose"], w: "select",
    gen(lv, R) { const it = R.shuffle(EP_POOL[lv].map((x) => x.slice())); return { lv, items: it.map((x, k) => [`${pick(R, ["web", "api", "kafka"]) && ""}${lv === 3 ? "kafka" : "web"}-${["a1", "b7", "c3", "d9", "e2", "f5"][k]}: ${x[0]}`, x[1]]) }; },
    text: (I) => I.lv === 3 ? `<p>The headless Service <code>kafka-headless</code> (selector <code>app=kafka</code>) has <code>publishNotReadyAddresses: true</code> so brokers can find each other while they start. Which pods appear as <b>ready</b> addresses in its EndpointSlice right now?</p>` : `<p>The Service <code>web</code> (selector <code>app=web</code>) load-balances over the ready endpoints in its EndpointSlice. Which of these pods get new requests right now?</p>`,
    ui: (I) => ({ opts: I.items.map((x) => x[0]) }),
    ans: (I) => I.items.map((x, k) => (x[1] ? k : -1)).filter((k) => k >= 0),
    diag: (I, a) => { const want = I.items.map((x, k) => (x[1] ? k : -1)).filter((k) => k >= 0); const w = I.items.findIndex((x, k) => x[1] !== a.includes(k)); return w >= 0 ? `Look again at “${esc(I.items[w][0])}”.` : `Expected ${want.length} pods.`; },
    hint: (I) => I.lv === 1 ? "A pod is a ready endpoint when its labels match and its Ready condition is True, which needs every container ready." : I.lv === 2 ? "Ready also requires every readiness gate condition to be True, and a terminating pod is never a ready endpoint." : "publishNotReadyAddresses marks addresses ready regardless of pod readiness, but the pod still needs to match and to have an IP.",
    concept: "EndpointSlice readiness",
    how: "The EndpointSlice controller adds every pod that matches the Service selector and has an IP. An endpoint is <i>ready</i> when the pod's Ready condition is True and the pod isn't terminating; Ready requires all containers (including sidecars) to pass readiness and every readinessGate condition to be True (a missing gate condition counts as False). Terminating pods are listed with ready=false and serving/terminating flags, so proxies stop sending them new connections. With <code>publishNotReadyAddresses: true</code> (used for StatefulSet peer discovery), all matching pods with an IP are published as ready.",
    rule: "When traffic goes somewhere unexpected, read the EndpointSlice's conditions (ready, serving, terminating), not just the pod status column.",
    why: (I) => `Ready endpoints: ${I.items.filter((x) => x[1]).map((x) => esc(x[0].split(":")[0])).join(", ")}.`,
  });

  /* ===== cluster autoscaler scale-down (select) ===== */
  const CA_POOL = [
    ["requests 22% of CPU; pods: 2 Deployment replicas (PDB allows 1), DaemonSets", true],
    ["requests 31%; pods: a bare pod (no controller) running a debug shell", false],
    ["requests 18%; pods: 1 replica annotated cluster-autoscaler.kubernetes.io/safe-to-evict: \"false\"", false],
    ["requests 64%; pods: 5 Deployment replicas", false],
    ["requests 27%; pods: kube-system/coredns replica (no PDB)", false],
    ["requests 15%; pods: only DaemonSet pods", true],
    ["requests 35%; pods: 1 replica whose PDB currently allows 0 disruptions", false],
    ["requests 12%; pods: a StatefulSet replica (PDB allows 1)", true],
    ["requests 40%; pods: 2 replicas that require zone eu-west-1c, where no other node has room", false],
  ];
  MORE.push({
    id: "k8s-ca-scale-down", name: "Which nodes can scale down?", kind: "Investigation", skills: ["diagnose", "estimate"], w: "select",
    gen(lv, R) { const n = lv === 1 ? 5 : lv === 2 ? 6 : 7; const idx = lv === 1 ? R.sample([0, 1, 3, 5, 2, 7], n) : R.sample(CA_POOL.map((_, k) => k), n); if (!idx.some((k) => CA_POOL[k][1]) || idx.every((k) => CA_POOL[k][1])) return null; if (lv === 3 && !idx.includes(8) && !idx.includes(4)) return null; return { lv, idx }; },
    text: (I) => `<p>The cluster autoscaler runs with default settings (scale-down utilization threshold 50% of requests, system pods block scale-down). The monthly bill says these nodes are mostly idle. Which ones will the autoscaler actually remove?</p>`,
    ui: (I) => ({ opts: I.idx.map((k, j) => `node-${j + 1}: ${CA_POOL[k][0]}`) }),
    ans: (I) => I.idx.map((k, j) => (CA_POOL[k][1] ? j : -1)).filter((j) => j >= 0),
    diag: (I, a) => { const w = I.idx.findIndex((k, j) => CA_POOL[k][1] !== a.includes(j)); return `Look again at node-${w + 1}.`; },
    hint: () => "A node is removed only if it's under the threshold and every pod on it (DaemonSets aside) can be evicted and rescheduled elsewhere.",
    concept: "Cluster autoscaler scale-down blockers",
    how: "The cluster autoscaler considers a node for removal when the sum of its pods' requests is below the utilization threshold (50% by default) for a while, then simulates evicting every pod. It won't remove the node if a pod has no controller, is annotated <code>cluster-autoscaler.kubernetes.io/safe-to-evict: \"false\"</code>, is a kube-system pod without a PDB (default), would violate its PDB, or can't fit on any other node (affinity, zone, resources). DaemonSet pods don't block. One stray debug pod can keep an expensive node alive for months.",
    rule: "If nodes don't scale down, check the autoscaler's status for the blocking pod: bare pods, safe-to-evict annotations, PDBs with 0 allowed disruptions and pods pinned to a full zone are the usual suspects.",
    why: (I) => I.idx.map((k, j) => `node-${j + 1}: ${CA_POOL[k][1] ? "removable" : "kept"}`).join("; ") + ".",
  });

  /* ===== manifest review (lines) ===== */
  const MR = {
    1: (a) => [["@@ deploy/" + a + ".yaml @@", "@"], ["apiVersion: apps/v1", " "], ["kind: Deployment", " "], ["metadata:", " "], [`  name: ${a}`, " "], ["spec:", " "], ["  replicas: 3", "-"], ["  replicas: 1", "+", 1], ["  template:", " "], ["    spec:", " "], ["      containers:", " "], [`      - name: ${a}`, " "], [`        image: registry.corp.internal/shop/${a}:2.4.1`, "-"], [`        image: registry.corp.internal/shop/${a}:latest`, "+", 1], ["        env:", "+"], ["        - name: LOG_LEVEL", "+"], ["          value: info", "+"], ["        - name: DB_PASSWORD", "+"], ["          value: \"Pr0d-db-2026!\"", "+", 1], ["        resources:", " "], ["          requests:", " "], ["            cpu: 250m", " "], ["            memory: 512Mi", " "]],
    2: (a) => [["@@ deploy/" + a + ".yaml @@", "@"], ["  strategy:", " "], ["    rollingUpdate:", " "], ["      maxSurge: 25%", " "], ["      maxUnavailable: 25%", "-"], ["      maxUnavailable: 100%", "+", 1], ["  template:", " "], ["    metadata:", " "], ["      labels:", " "], [`        app: ${a}`, " "], ["        team: checkout", "+"], ["    spec:", " "], ["      terminationGracePeriodSeconds: 30", " "], ["      containers:", " "], [`      - name: ${a}`, " "], ["        livenessProbe:", " "], ["          httpGet:", " "], ["            path: /healthz", "-"], ["            path: /ready   # also checks DB and Redis", "+", 1], ["            port: 8080", " "], ["        readinessProbe:", "-", 1], ["          httpGet:", "-"], ["            path: /ready", "-"], ["            port: 8080", "-"], ["        resources:", " "], ["          limits:", " "], ["            memory: 1Gi", " "]],
    3: (a) => [["@@ deploy/" + a + ".yaml @@", "@"], ["spec:", " "], ["  selector:", " "], ["    matchLabels:", " "], [`      app: ${a}`, " "], ["      tier: backend", "+", 1], ["  template:", " "], ["    metadata:", " "], ["      labels:", " "], [`        app: ${a}`, " "], ["        tier: backend", "+"], ["    spec:", " "], ["      terminationGracePeriodSeconds: 30", " "], ["      containers:", " "], [`      - name: ${a}`, " "], ["        env:", " "], ["        - name: JAVA_TOOL_OPTIONS", " "], ["          value: \"-Xmx768m\"", "-"], ["          value: \"-Xmx1536m\"", "+", 1], ["        lifecycle:", "+"], ["          preStop:", "+"], ["            exec:", "+"], ["              command: [\"sleep\", \"45\"]", "+", 1], ["        resources:", " "], ["          limits:", " "], ["            memory: 1Gi", " "], ["          requests:", " "], ["            cpu: 500m", "-"], ["            cpu: 750m", "+"]],
  };
  MORE.push({
    id: "k8s-manifest-review", name: "Review the Deployment change", kind: "Code review", skills: ["safe", "diagnose"], w: "lines",
    gen(lv, R) { return { lv, app: pick(R, ["checkout", "orders", "pricing", "ledger"]) }; },
    text: (I) => `<p>Review this pull request to the <b>${esc(I.app)}</b> production Deployment. Flag the <b>3</b> lines that would cause an incident or a security problem${I.lv === 1 ? "" : I.lv === 2 ? ` (the service sits behind a PDB with maxUnavailable 1; the DB and Redis are shared with five other services)` : ` (the Deployment already exists in production; requests take up to 20 s)`}. Everything else is fine.</p>`,
    ui: (I) => ({ file: `deploy/${I.app}.yaml`, k: 3, lines: MR[I.lv](I.app).map((x) => ({ t: x[0], k: x[1] })) }),
    ans: (I) => MR[I.lv](I.app).map((x, k) => (x[2] ? k : -1)).filter((k) => k >= 0),
    diag: () => "Not those three. For each flagged line, ask what concretely breaks in production.",
    hint: (I) => I.lv === 1 ? "Availability, reproducibility, secrets." : I.lv === 2 ? "What happens to all pods at once during a rollout, and during a 30-second Redis blip?" : "Some fields of an existing Deployment can't change; memory has a hard ceiling; and timing adds up during termination.",
    concept: "Reviewing Kubernetes manifests",
    how: "Most Kubernetes incidents start as one innocent-looking line: a single replica (any node drain is an outage), a mutable <code>:latest</code> tag (no reproducible rollback, different nodes may run different code), a password in plain env (visible to anyone who can read the Deployment, and in Git), maxUnavailable 100% (a rollout takes everything down), a liveness probe on a dependency check (a shared outage restarts every pod), a removed readiness probe (traffic before warm-up), a changed selector (immutable on an existing Deployment), a heap bigger than the memory limit (OOMKilled under load), and a preStop longer than the grace period (SIGKILL before draining).",
    rule: "In manifest reviews, check replicas/PDB, image immutability, secrets, rollout strategy, probes, selectors, memory vs runtime settings and termination timing.",
    why: (I) => I.lv === 1 ? "replicas: 1 makes every drain or crash an outage; :latest makes rollbacks meaningless; the DB password belongs in a Secret, not a literal in the manifest."
      : I.lv === 2 ? "maxUnavailable 100% lets a rollout kill every pod at once; a liveness probe on /ready restarts all pods whenever the shared DB or Redis blips; dropping the readiness probe sends traffic to pods before they're ready."
        : "Adding tier to spec.selector fails on the existing Deployment (the selector is immutable); a 1536m heap can't fit a 1Gi limit and will be OOMKilled; a 45 s preStop exceeds the 30 s grace period, so pods get SIGKILLed before finishing 20 s requests.",
  });

  /* ===== estimates (num) ===== */
  MORE.push({
    id: "k8s-pods-per-node", name: "How many pods fit on a node?", kind: "Estimate", skills: ["estimate"], w: "num",
    gen(lv, R) {
      const I = { lv, cpu: R.pick([500, 750, 1000]), mem: R.pick([1024, 1536, 2048]), dsCpu: R.pick([150, 200, 300]), dsMem: R.pick([200, 300, 400]), dsPods: R.int(3, 5) };
      if (lv === 3) { I.cpu = R.pick([50, 100]); I.mem = R.pick([64, 128]); }
      I.allocCpu = 3920; I.capMem = 16384; I.kubeRes = R.pick([1024, 1229]); I.sysRes = R.pick([0, 100]); I.evict = 100;
      I.allocMem = lv === 1 ? R.pick([14480, 14300]) : I.capMem - I.kubeRes - I.sysRes - I.evict;
      I.maxPods = 58;
      return I;
    },
    text: (I) => `<p>Nodes are m6i.xlarge (4 vCPU, 16 GiB). ${I.lv === 1 ? `<code>kubectl describe node</code> shows Allocatable cpu 3920m, memory ${I.allocMem}Mi.` : `Allocatable CPU is 3920m. For memory the kubelet reserves kube-reserved ${I.kubeRes}Mi${I.sysRes ? ` and system-reserved ${I.sysRes}Mi` : ""}, with an eviction threshold of memory.available&lt;${I.evict}Mi.`}${I.lv === 3 ? ` The VPC CNI limits the node to ${I.maxPods} pods.` : ""} DaemonSets put ${I.dsPods} pods on every node requesting ${I.dsCpu}m CPU and ${I.dsMem}Mi in total.</p><p>How many replicas of a pod requesting <b>${I.cpu}m CPU and ${I.mem}Mi</b> fit on one empty node?</p>`,
    ui: () => ({ unit: "pods" }),
    ans: (I) => Math.min(Math.floor((I.allocCpu - I.dsCpu) / I.cpu), Math.floor((I.allocMem - I.dsMem) / I.mem), I.lv === 3 ? I.maxPods - I.dsPods : Infinity),
    diag: (I, a) => (a > Math.min(Math.floor((I.allocCpu - I.dsCpu) / I.cpu), Math.floor((I.allocMem - I.dsMem) / I.mem), I.lv === 3 ? I.maxPods - I.dsPods : 1e9) ? "Too high: some limit is binding earlier." : "Too low. Recheck which resource runs out first."),
    hint: (I) => I.lv === 1 ? "Subtract the DaemonSets from allocatable, then divide each resource by the pod's request; the smaller wins." : I.lv === 2 ? "Allocatable memory = capacity − kube-reserved − system-reserved − eviction threshold." : "With tiny pods, the maximum pod count per node can bind before CPU or memory, and DaemonSet pods count towards it.",
    concept: "Node allocatable and bin-packing",
    how: "The scheduler packs pods by requests against a node's <i>allocatable</i>: capacity minus kube-reserved, system-reserved and the hard eviction threshold. DaemonSet pods are scheduled on every node first and consume part of it. The number of pods that fit is the minimum over CPU, memory and the node's max-pods limit; on AWS's VPC CNI that limit comes from the instance's ENIs and IPs per ENI (58 on an m6i.xlarge) unless prefix delegation is enabled.",
    rule: "Capacity-plan with allocatable minus DaemonSets, check every dimension including max pods, and size pods so the expensive resource is the one that runs out.",
    why: (I) => { const c = Math.floor((I.allocCpu - I.dsCpu) / I.cpu), m = Math.floor((I.allocMem - I.dsMem) / I.mem), p = I.lv === 3 ? I.maxPods - I.dsPods : null; return `CPU: (3920 − ${I.dsCpu}) / ${I.cpu} = ${c}; memory: (${I.allocMem} − ${I.dsMem}) / ${I.mem} = ${m}${p != null ? `; pod limit: ${I.maxPods} − ${I.dsPods} DaemonSet pods = ${p}` : ""}. The binding constraint gives ${Math.min(c, m, p == null ? Infinity : p)}.`; },
  });
  function caNodes(I) {
    const per = (p) => Math.min(Math.floor((3920 - 250) / p.cpu), Math.floor((14480 - 300) / p.mem));
    const fits = I.pods.filter((p) => p.cpu <= 3670 && p.mem <= 14180);
    // first-fit decreasing on new nodes
    const items = []; fits.forEach((p) => { for (let k = 0; k < p.n; k++) items.push(p); });
    items.sort((a, b) => b.mem - a.mem || b.cpu - a.cpu);
    const bins = [];
    items.forEach((p) => { const b = bins.find((x) => x.cpu + p.cpu <= 3670 && x.mem + p.mem <= 14180); if (b) { b.cpu += p.cpu; b.mem += p.mem; } else bins.push({ cpu: p.cpu, mem: p.mem }); });
    void per;
    return Math.min(bins.length, I.max - I.cur);
  }
  MORE.push({
    id: "k8s-ca-scale-up", name: "How many nodes will the autoscaler add?", kind: "Estimate", skills: ["estimate"], w: "num",
    gen(lv, R) {
      const I = { lv, cur: R.int(4, 8), max: 30, pods: [{ name: "web", n: R.int(10, 18), cpu: 1000, mem: 2048 }] };
      if (lv >= 2) I.pods.push({ name: "worker", n: R.int(3, 6), cpu: 500, mem: R.pick([6144, 5120]) });
      if (lv === 3) { I.pods.push({ name: "ml-batch", n: 2, cpu: 2000, mem: 20480 }); I.max = I.cur + R.int(3, 5); }
      const v = caNodes(I);
      if (lv === 3 && v !== I.max - I.cur) return null;
      return I;
    },
    text: (I) => `<p>A traffic spike leaves these pods <code>Pending</code>: ${I.pods.map((p) => `<b>${p.n}× ${p.name}</b> (${p.cpu}m, ${p.mem / 1024}Gi)`).join(", ")}. The node group uses m6i.xlarge (allocatable 3920m / 14480Mi; DaemonSets take 250m / 300Mi per node), currently ${I.cur} nodes${I.lv === 3 ? `, max size ${I.max}` : ""}; existing nodes are full. The autoscaler simulates packing the pending pods onto new nodes.</p><p>How many nodes does this scale-up add?</p>`,
    ui: () => ({ unit: "nodes" }),
    ans: (I) => caNodes(I),
    diag: (I, a) => (a > caNodes(I) ? "Too high. Did you pack pods of different shapes together, and respect every limit?" : "Too low. Check both CPU and memory per node."),
    hint: (I) => I.lv === 1 ? "Work out how many pods fit on one new node after DaemonSets, for CPU and for memory." : I.lv === 2 ? "Memory-heavy and CPU-heavy pods can share a node." : "A pod that can't fit on even an empty node of this group doesn't trigger a scale-up from it; and the group has a maximum.",
    concept: "Cluster autoscaler scale-up",
    how: "When pods are unschedulable, the cluster autoscaler asks each node group: if I added nodes like the ones in this group (allocatable minus DaemonSets), would these pods fit? It bin-packs the pending pods onto hypothetical new nodes to decide how many to add, capped by the group's max size. Pods that wouldn't fit even on an empty node (too large, wrong zone, untolerated taint) are reported as 'pod didn't trigger scale-up' and stay Pending.",
    rule: "Check pending pods against an empty node's allocatable, not its capacity, and keep node group max sizes and pod shapes in mind when you size spike capacity.",
    why: (I) => `Packing the pods that fit onto empty m6i.xlarge nodes (3670m / 14180Mi usable) needs ${caNodes(I)} node(s)${I.lv === 3 ? `, which is also the ${I.max - I.cur} the group's max size allows; the 20Gi ml-batch pods fit no node in this group and don't count` : ""}.`,
  });
  MORE.push({
    id: "k8s-dns-ndots", name: "Count the DNS queries", kind: "Estimate", skills: ["estimate", "diagnose"], w: "num",
    gen(lv, R) { return { lv, ns: pick(R, ["shop", "payments", "search"]), host: pick(R, ["api.partner-bank.com", "hooks.mailer.io", "auth.idp-cloud.net"]), extra: lv === 2 ? "eu-west-1.compute.internal" : null }; },
    text: (I) => {
      const search = [`${I.ns}.svc.cluster.local`, "svc.cluster.local", "cluster.local", ...(I.extra ? [I.extra] : [])];
      const conf = `search ${search.join(" ")}\nnameserver 172.20.0.10\noptions ndots:${I.lv === 3 ? 2 : 5}`;
      return `<p>CoreDNS CPU tripled after a new integration launched. A pod's <code>/etc/resolv.conf</code>:</p>${K.pre(conf)}<p>The resolver sends A and AAAA queries for each candidate name and stops at the first name that exists. ${I.lv === 3 ? `After setting <code>dnsConfig.options ndots: 2</code>, each request looks up <code>${I.host}</code> and the in-cluster name <code>redis.cache</code> (Service <code>redis</code> in namespace <code>cache</code>).</p><p>How many DNS queries does one request now cause in total?` : `How many DNS queries does one lookup of <code>${I.host}</code> send?`}</p>`;
    },
    ui: () => ({ unit: "queries" }),
    ans: (I) => (I.lv === 1 ? 8 : I.lv === 2 ? 10 : 2 + 4),
    diag: (I, a) => (a < (I.lv === 1 ? 8 : I.lv === 2 ? 10 : 6) ? "Too low. Count every candidate name, and both record types." : "Too high. Where does the search stop?"),
    hint: (I) => I.lv < 3 ? "A name with fewer dots than ndots is tried with each search domain first, and only then as written." : "With ndots: 2, which of the two names has enough dots to be tried as-is first? For the other, which search domain matches first?",
    concept: "ndots and DNS search lists",
    how: "Kubernetes gives pods a resolv.conf with three cluster search domains (plus the node's own, on many clouds) and ndots:5. Any name with fewer than five dots, which is nearly every external hostname, is first tried with each search domain appended, each attempt sending A and AAAA queries and getting NXDOMAIN, before the name is tried as written. An external lookup can cost 8–10 queries. Lowering ndots (dnsConfig), using fully qualified names with a trailing dot, or caching (NodeLocal DNSCache) cuts the load; short in-cluster names still need the search list.",
    rule: "For pods that call external APIs, use FQDNs with a trailing dot or set ndots to 1–2, and run NodeLocal DNSCache on busy clusters.",
    why: (I) => I.lv === 1 ? `${esc(I.host)} has 2 dots (< 5), so it's tried with the 3 search domains and then as written: 4 names × (A + AAAA) = 8 queries, 6 of them pointless NXDOMAINs.`
      : I.lv === 2 ? `The node adds a fourth search domain (${esc(I.extra)}): 5 names × 2 = 10 queries per lookup.`
        : `${esc(I.host)} now has enough dots (2 ≥ 2) and is tried as written first: 2 queries. redis.cache has 1 dot, so the search list applies: redis.cache.${esc(I.ns)}.svc.cluster.local fails, redis.cache.svc.cluster.local exists: 2 names × 2 = 4. Total 6.`,
  });

  /* ===== choose the PDB (choice) ===== */
  const PDB_Q = {
    1: { ctx: (a) => `<b>${esc(a)}</b> is a stateless Deployment with 3 replicas; losing one is fine, losing two at once overloads the third. Node drains must never be blocked.`, opts: ["maxUnavailable: 1", "minAvailable: 3", "minAvailable: 1", "no PDB"], right: "maxUnavailable: 1", why: "maxUnavailable: 1 lets drains proceed one pod at a time. minAvailable: 3 blocks every drain; minAvailable: 1 allows two pods down at once; no PDB lets a drain evict all three together." },
    2: { ctx: (a) => `<b>${esc(a)}</b> is a 5-member ZooKeeper ensemble (quorum 3). An unplanned node failure can happen during any maintenance.`, opts: ["maxUnavailable: 1", "minAvailable: 3", "minAvailable: 5", "maxUnavailable: 2"], right: "maxUnavailable: 1", why: "With maxUnavailable: 1, a planned eviction plus an unplanned failure still leaves 3 of 5. minAvailable: 3 (or maxUnavailable: 2) allows two planned evictions at once, so one surprise failure loses quorum; minAvailable: 5 blocks every drain." },
    3: { ctx: (a) => `<b>${esc(a)}</b> autoscales between 2 and 20 replicas. Never lose more than ~10% of capacity to voluntary disruptions, and never block a node drain, at any replica count.`, opts: ["maxUnavailable: 10%", "minAvailable: 90%", "minAvailable: 2", "maxUnavailable: 0"], right: "maxUnavailable: 10%", why: "maxUnavailable: 10% rounds up, so 1 pod at 2–10 replicas and 2 at 20: drains always progress. minAvailable: 90% rounds up to 2 of 2 at low traffic, allowing zero disruptions and blocking drains overnight; minAvailable: 2 allows 18 of 20 down at peak; maxUnavailable: 0 blocks everything." },
  };
  MORE.push({
    id: "k8s-pdb-choice", name: "Choose the disruption budget", kind: "Decision", skills: ["design", "safe"], w: "choice",
    gen(lv, R) { return { lv, app: pick(R, lv === 2 ? ["zk", "zookeeper", "coord"] : ["checkout", "search", "feed"]), order: R.shuffle([0, 1, 2, 3]) }; },
    text: (I) => `<p>${PDB_Q[I.lv].ctx(I.app)}</p><p>Which PodDisruptionBudget should it have?</p>`,
    ui: (I) => ({ opts: I.order.map((k) => PDB_Q[I.lv].opts[k]) }),
    ans: (I) => PDB_Q[I.lv].right,
    diag: () => "Work out how many disruptions that budget allows at each replica count you care about.",
    hint: (I) => I.lv === 3 ? "Percentages round up for both fields. Compute the allowed disruptions at 2 replicas and at 20." : "A PDB limits voluntary evictions only; unplanned failures come on top.",
    concept: "Sizing PodDisruptionBudgets",
    how: "A PDB caps voluntary disruptions (evictions by drains, autoscaler scale-down, upgrades) for the pods it selects: allowed = healthy pods − minAvailable, or maxUnavailable − unhealthy pods. Percentages are rounded up. Unplanned failures aren't prevented, but they count against the budget once they happen. A budget that allows 0 disruptions blocks every drain; one that allows too many lets a maintenance take out capacity or quorum.",
    rule: "Prefer maxUnavailable (it scales with replica count and never blocks a healthy workload); for quorum systems leave room for one unplanned failure on top of the planned one.",
    why: (I) => PDB_Q[I.lv].why,
  });
  /* ---------- registration (see c-k8s.js) ---------- */
  if (D.lab._k8sDone) LB.addAll("k8s", MORE);
  else D.lab._k8sMore = MORE;
})();
