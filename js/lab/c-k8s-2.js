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
    if (I.lv >= 2) {
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
  /* ---------- registration (see c-k8s.js) ---------- */
  if (D.lab._k8sDone) LB.addAll("k8s", MORE);
  else D.lab._k8sMore = MORE;
})();
