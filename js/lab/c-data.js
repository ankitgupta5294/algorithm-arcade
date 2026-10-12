/* Systems Lab · Data-centric engineering (part 1): races, migrations, reviews and judgment calls that every backend
   engineer meets. Interleave levels replay a schedule against a tiny model of the app, its database and its neighbours. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const S = [];

  /* ---------- interleave helpers: lanes of ops that act on shared state ---------- */
  // M = { init, lanes: [{ name, steps:[text], ops:[(S, v, ctx) -> note | {note, err}] }], broken(r), verdict(r), end?(S, V) }
  function* ilvs(lens) {
    const left = lens.slice(), cur = [], total = lens.reduce((a, b) => a + b, 0);
    function* go() { if (cur.length === total) { yield cur.slice(); return; } for (let l = 0; l < left.length; l++) if (left[l] > 0) { left[l]--; cur.push(l); yield* go(); cur.pop(); left[l]++; } }
    yield* go();
  }
  function play(M, seq) {
    const St = K.clone(M.init), V = M.lanes.map(() => ({})), pos = M.lanes.map(() => 0), dead = M.lanes.map(() => false), log = [];
    const ctx = { kill: (k) => (dead[k] = true), V, log };
    for (const l of seq || []) {
      const i = pos[l]++;
      if (i >= M.lanes[l].steps.length) continue;
      const label = M.lanes[l].steps[i];
      if (dead[l]) { log.push({ t: l, label, note: "never runs: that process is gone", err: true }); continue; }
      const r = M.lanes[l].ops[i](St, V[l], ctx);
      log.push({ t: l, label, note: typeof r === "string" ? r : r ? r.note : "", err: !!(r && r.err) });
    }
    const total = M.lanes.reduce((s, x) => s + x.steps.length, 0);
    const complete = (seq || []).length === total;
    if (complete && M.end) { const n = M.end(St, V, dead); if (n) log.push({ t: -1, label: "afterwards", note: n }); }
    return { S: St, V, log, dead, complete };
  }
  const trace = (M, r) => K.table(["", ...M.lanes.map((l) => esc(l.name))], r.log.map((e, k) => [String(k + 1), ...M.lanes.map((_, j) => (j === e.t || (e.t === -1 && j === 0) ? `${e.t === -1 ? "<i>" + esc(e.label) + "</i>" : `<span class="mono">${esc(e.label)}</span>`}${e.note ? `<br><small class="${e.err ? "lose" : "muted"}">${esc(e.note)}</small>` : ""}` : ""))]), { compact: true });
  // Build an interleave scenario from model(I). Players must find a schedule that breaks the code.
  function ilv(o) {
    return {
      w: "interleave",
      ui: (I) => { const M = o.model(I); return { lanes: M.lanes.map((l) => ({ name: l.name, steps: l.steps })), live: (seq) => { const r = play(M, seq || []); return trace(M, r) + (r.complete ? K.verdict(M.broken(r), M.verdict(r)) : `<p class="muted small">Schedule every step to see the outcome.</p>`); } }; },
      accept(I, seq) { const M = o.model(I); const r = play(M, seq); return M.broken(r) ? true : `Everything stays consistent with this schedule: ${esc(M.verdict(r))}. ${o.nudge || "Try overlapping the lanes differently."}`; },
      solve(I) { const M = o.model(I); for (const s of ilvs(M.lanes.map((l) => l.steps.length))) if (M.broken(play(M, s))) return s; return null; },
      bad(I) { const M = o.model(I); const ls = M.lanes.map((l, k) => l.steps.map(() => k)); const a = ls.flat(), b = ls.slice().reverse().flat(); return [a, b].filter((s) => !M.broken(play(M, s))); },
      ...o,
    };
  }

  /* ---------- review helpers: flag lines in a diff ---------- */
  // L = { file, lines: [{t, k, bad: true | 'opt', ok?: 'why this line is fine'}] }
  function flag(o) {
    const req = (L) => L.lines.map((x, i) => (x.bad === true ? i : -1)).filter((i) => i >= 0);
    return {
      w: "lines",
      ui: (I) => { const L = o.diff(I); return { file: L.file, lines: L.lines.map((x) => ({ t: x.t, k: x.k })) }; },
      accept(I, a) {
        const L = o.diff(I), need = req(L);
        const wrong = a.filter((i) => L.lines[i] && !L.lines[i].bad);
        if (wrong.length) { const x = L.lines[wrong[0]]; return `<code>${esc(x.t.trim())}</code> is fine. ${x.ok || ""}`; }
        const miss = need.filter((i) => !a.includes(i));
        if (miss.length) return `You found ${need.length - miss.length} of the problem lines; ${miss.length} more line${miss.length > 1 ? "s" : ""} in this diff also cause${miss.length > 1 ? "" : "s"} trouble.`;
        return true;
      },
      solve: (I) => req(o.diff(I)),
      bad(I) {
        const L = o.diff(I), need = req(L), out = [];
        if (need.length > 1) out.push(need.slice(1));
        const fine = L.lines.findIndex((x) => x.k !== "@" && !x.bad);
        if (fine >= 0) out.push([...need, fine].sort((a, b) => a - b));
        return out;
      },
      ...o,
    };
  }
  const dl = (k, t, bad, ok) => ({ k, t, bad, ok });

  /* ================= interleave scenarios ================= */

  S.push(ilv({
    id: "data-double-charge",
    name: "Charged twice on retry",
    kind: "Incident",
    skills: ["diagnose", "design"],
    gen(lv, R) { return { lv, order: R.int(10000, 99999), amt: R.pick([19, 24, 39, 49, 89, 129]) + 0.99 * R.int(0, 1), key: "ik_" + R.int(100000, 999999).toString(36) }; },
    model(I) {
      const usd = "$" + I.amt.toFixed(2);
      if (I.lv === 1) {
        const lane = (n) => ({ name: n, steps: [`SELECT status FROM orders WHERE id = ${I.order}`, `if 'unpaid': psp.charge(card, ${usd})`, `UPDATE orders SET status = 'paid' WHERE id = ${I.order}`],
          ops: [(s, v) => { v.st = s.status; return `sees status = '${s.status}'`; }, (s, v) => { if (v.st !== "unpaid") return "already paid: returns 200 without charging"; s.charges++; v.ch = true; return `card charged ${usd}`; }, (s, v) => { if (!v.ch) return "skipped"; s.status = "paid"; return "status = 'paid'"; }] });
        return { init: { status: "unpaid", charges: 0 }, lanes: [lane("Request A (original)"), lane("Request B (client retry)")], broken: (r) => r.S.charges > 1, verdict: (r) => `${r.S.charges} charge${r.S.charges === 1 ? "" : "s"} on the customer's card` };
      }
      if (I.lv === 2) {
        const lane = (n) => ({ name: n, steps: [`SELECT response FROM idempotency_keys WHERE key = '${I.key}'`, `if none: psp.charge(card, ${usd})`, `INSERT INTO idempotency_keys (key, response) VALUES ('${I.key}', ...)`],
          ops: [(s, v) => { v.hit = s.stored; return v.hit ? "found a stored response" : "no row"; }, (s, v) => { if (v.hit) return "returns the stored response"; s.charges++; v.ch = true; return `card charged ${usd}`; }, (s, v) => { if (!v.ch) return "skipped"; if (s.stored) return { note: "ERROR: duplicate key value violates unique constraint \"idempotency_keys_pkey\" → 500 (but the card was already charged)", err: true }; s.stored = true; return "stored"; }] });
        return { init: { stored: false, charges: 0 }, lanes: [lane("Request A (original)"), lane("Request B (retry, same key)")], broken: (r) => r.S.charges > 1, verdict: (r) => `${r.S.charges} charge${r.S.charges === 1 ? "" : "s"} on the customer's card` };
      }
      return {
        init: { key: null, charges: 0 },
        lanes: [
          { name: "Request A (original)", steps: [`INSERT INTO idempotency_keys (key, state) VALUES ('${I.key}', 'started') ON CONFLICT DO NOTHING`, `psp.charge(card, ${usd}) → read timeout after 10 s`, `on error: DELETE FROM idempotency_keys WHERE key = '${I.key}'; return 502`],
            ops: [(s, v) => { if (s.key) { v.no = true; return `key exists (${s.key}) → returns 409 / stored response`; } s.key = "started"; return "reserved the key"; }, (s, v) => { if (v.no) return "skipped"; s.charges++; return { note: `PSP charged ${usd}, but its response never arrived`, err: false }; }, (s, v) => { if (v.no) return "skipped"; s.key = null; return "key released \"so the client can retry\""; }] },
          { name: "Request B (retry, same key)", steps: [`INSERT INTO idempotency_keys (key, state) VALUES ('${I.key}', 'started') ON CONFLICT DO NOTHING`, `psp.charge(card, ${usd})`, `UPDATE idempotency_keys SET state = 'done', response = ... WHERE key = '${I.key}'`],
            ops: [(s, v) => { if (s.key) { v.no = true; return `key exists (${s.key}) → returns 409 Conflict, client will retry later`; } s.key = "started"; return "reserved the key"; }, (s, v) => { if (v.no) return "skipped"; s.charges++; return `card charged ${usd}`; }, (s, v) => { if (v.no) return "skipped"; s.key = "done"; return "response stored"; }] },
        ],
        broken: (r) => r.S.charges > 1, verdict: (r) => `${r.S.charges} charge${r.S.charges === 1 ? "" : "s"} on the customer's card`,
      };
    },
    text: (I) => `<p><b>Support ticket:</b> customers on the mobile app are being charged twice for order-sized amounts. The app times out after 3 s and retries <code>POST /orders/${I.order}/pay</code>; the payment provider (PSP) often takes longer than that, so both requests are in flight at once.</p>
      <p>${I.lv === 1 ? "The handler checks the order's status before charging." : I.lv === 2 ? `The client sends an <code>Idempotency-Key: ${I.key}</code> header (same on retry). The handler looks the key up, charges, then stores the response. The table has a primary key on <code>key</code>.` : `The handler reserves the idempotency key <i>before</i> charging, which closes the race. But when the PSP call fails it deletes the key so the client can try again.`}</p><p><b>Find a schedule that charges the card twice.</b></p>`,
    hint: (I) => I.lv === 1 ? "Let both requests read the status before either writes it." : I.lv === 2 ? "The unique constraint fires, but when, relative to the charge?" : "A timeout doesn't mean the charge failed. What does deleting the key allow?",
    concept: "Idempotency keys: reserve first, never release on an ambiguous outcome",
    how: "A client retry and the original request run concurrently, so any check-then-act on shared state (order status, a key lookup) races. An idempotency key only protects a side effect if it's claimed atomically <i>before</i> the side effect (INSERT … ON CONFLICT DO NOTHING, or SET NX) and the result is stored against it afterwards. A unique constraint that fires after the PSP call only turns a double charge into a double charge plus a 500. A timeout is an unknown outcome, not a failure: releasing the key lets the retry charge again. Pass the same key to the PSP so it deduplicates too, and reconcile 'started' keys against the PSP.",
    rule: "Claim the key atomically before the side effect, store the response after it, and on timeouts keep the key and reconcile; never delete it.",
    why: (I) => I.lv === 1 ? `Both requests saw <code>unpaid</code> before either marked the order paid, so both called the PSP. Status checks aren't a lock.` : I.lv === 2 ? `Both lookups missed, both charged, and only then did the primary key reject the second INSERT. The key has to be inserted before calling the PSP.` : `Request A's PSP call timed out after the PSP had charged the card; deleting the key let request B reserve it again and charge a second time. Keep the key in a 'started' state, pass ${I.key} to the PSP as its idempotency key, and reconcile.`,
  }));

  S.push(ilv({
    id: "data-outbox-crash",
    name: "Kill the pod mid-write",
    kind: "Design review",
    skills: ["design", "diagnose"],
    gen(lv, R) { return { lv, order: R.int(100000, 999999), topic: R.pick(["orders.created", "orders.v1", "order-events"]) }; },
    model(I) {
      const T = I.topic;
      if (I.lv < 3) {
        const svc = I.lv === 1
          ? { steps: ["BEGIN", `INSERT INTO orders (id, ...) VALUES (${I.order}, ...)`, "COMMIT", `producer.send('${T}', OrderCreated ${I.order})`, "return 201"],
            ops: [() => "transaction open", (s, v) => { v.ins = true; return "row written (uncommitted)"; }, (s, v) => { s.db = true; return "order committed"; }, (s) => { s.ev = true; return "event published"; }, () => "client gets 201"] }
          : { steps: ["BEGIN", `INSERT INTO orders (id, ...) VALUES (${I.order}, ...)`, `producer.send('${T}', OrderCreated ${I.order})  -- inside the transaction`, "COMMIT", "return 201"],
            ops: [() => "transaction open", (s, v) => { v.ins = true; return "row written (uncommitted)"; }, (s) => { s.ev = true; return "event published (Kafka has no idea about the DB transaction)"; }, (s) => { s.db = true; return "order committed"; }, () => "client gets 201"] };
        return {
          init: { db: false, ev: false },
          lanes: [{ name: "order-service", ...svc }, { name: "Kubernetes", steps: ["pod OOMKilled (SIGKILL)"], ops: [(s, v, c) => { c.kill(0); return s.db ? "process gone (committed data survives)" : "process gone; the open transaction is rolled back"; }] }],
          broken: (r) => r.S.db !== r.S.ev,
          verdict: (r) => r.S.db && !r.S.ev ? "order exists but no event: shipping and email never hear about it" : !r.S.db && r.S.ev ? "event published for an order that doesn't exist: downstream ships a phantom order" : r.S.db ? "order and event both exist" : "neither exists (client saw an error and can retry)",
        };
      }
      return {
        init: { committed: false, sent: false, pub: 0 },
        lanes: [
          { name: "order-service", steps: ["BEGIN", `INSERT INTO orders ... (${I.order})`, `INSERT INTO outbox (topic, payload) VALUES ('${T}', ...)`, "COMMIT"], ops: [() => "transaction open", () => "order row (uncommitted)", () => "outbox row (uncommitted)", (s) => { s.committed = true; return "order + outbox row committed atomically"; }] },
          { name: "outbox relay", steps: ["SELECT * FROM outbox WHERE sent_at IS NULL", `producer.send('${T}', row)`, "UPDATE outbox SET sent_at = now() WHERE id = ..."], ops: [(s, v) => { v.rows = s.committed && !s.sent; return v.rows ? "1 unsent row" : "0 rows (nothing committed yet)"; }, (s, v) => { if (!v.rows) return "nothing to send"; s.pub++; return `published (delivery #${s.pub})`; }, (s, v) => { if (!v.rows) return "nothing to mark"; s.sent = true; return "marked sent"; }] },
          { name: "Kubernetes", steps: ["relay pod killed; replacement relay runs one poll → send → mark cycle"], ops: [(s, v, c) => { c.kill(1); if (s.committed && !s.sent) { s.pub++; s.sent = true; return `new relay finds the row unsent and publishes it (delivery #${s.pub})`; } return "new relay finds nothing to send"; }] },
        ],
        end: (s) => { if (s.committed && !s.sent) { s.pub++; s.sent = true; return `the relay keeps polling and publishes the row (delivery #${s.pub})`; } return ""; },
        broken: (r) => r.S.pub > 1,
        verdict: (r) => `event delivered ${r.S.pub} time${r.S.pub === 1 ? "" : "s"}`,
      };
    },
    nudge: "Where exactly can the process die?",
    text: (I) => I.lv < 3 ? `<p><code>order-service</code> writes the order to Postgres and publishes <code>OrderCreated</code> to Kafka topic <code>${I.topic}</code>${I.lv === 2 ? ", sending the event <i>before</i> COMMIT because \"then we only commit if publishing worked\"" : " right after COMMIT"}. Pods get OOMKilled a few times a day.</p><p><b>Find a moment to kill the pod that leaves the database and the topic disagreeing.</b></p>`
      : `<p>After two incidents the team adopted the <b>transactional outbox</b>: the order and an outbox row commit in one transaction, and a relay publishes unsent rows and then marks them sent. The team now says consumers \"never see duplicates\".</p><p><b>Find a schedule where the consumer receives the same event twice.</b> Placing the relay crash is up to you.</p>`,
    hint: (I) => I.lv === 1 ? "Kill it between the two writes." : I.lv === 2 ? "What if the process dies after Kafka has the event but before COMMIT?" : "Kill the relay after it sends but before it marks the row.",
    concept: "Dual writes vs the transactional outbox",
    how: "Writing to a database and a broker are two separate commits; no ordering of them is atomic, so a crash in between leaves one without the other (a lost event, or an event for a rolled-back row). The transactional outbox writes the event into the same database transaction as the state change, and a relay (a poller or CDC such as Debezium) publishes it afterwards. That makes publishing at-least-once: the relay can crash after sending but before recording that it sent, so the event goes out again. Consumers must therefore be idempotent, typically by recording processed event ids.",
    rule: "Never write to two systems and hope; commit state and event together (outbox), then make every consumer dedupe by event id.",
    why: (I) => I.lv === 1 ? "Killing the pod after COMMIT but before producer.send leaves a committed order nobody downstream hears about." : I.lv === 2 ? "Killing the pod after send but before COMMIT rolls the order back while the event is already in Kafka: consumers act on an order that doesn't exist." : "The relay published the row, died before marking it sent, and its replacement published it again. The outbox gives at-least-once delivery; consumers need an inbox/dedup table keyed by event id.",
  }));

  S.push(ilv({
    id: "data-cache-race",
    name: "Stale price after the update",
    kind: "Investigation",
    skills: ["diagnose", "design"],
    gen(lv, R) { const p = R.int(10, 90); return { lv, id: R.int(100, 999), old: p, neu: p + R.int(1, 9) }; },
    model(I) {
      const key = `product:${I.id}`;
      const reader = (extra) => ({ name: "Reader (GET /products)", steps: [`GET ${key}`, `SELECT price FROM products WHERE id = ${I.id}`, ...(extra ? ["GC pause (1.2 s)"] : []), `SET ${key} <price> EX 3600`],
        ops: [(s, v) => { v.hit = s.cache != null; return v.hit ? `hit: ${s.cache}` : "miss"; }, (s, v) => { if (v.hit) return "skipped"; v.p = s.db; return `reads ${s.db}`; }, ...(extra ? [() => "stalled"] : []), (s, v) => { if (v.hit) return "skipped"; s.cache = v.p; return `cache = ${v.p}`; }] });
      let writer;
      if (I.lv === 1) writer = { name: "Writer (admin edit)", steps: [`UPDATE products SET price = ${I.neu} WHERE id = ${I.id}`, `DEL ${key}`], ops: [(s) => { s.db = I.neu; return `price = ${I.neu} (committed)`; }, (s) => { s.cache = null; return "cache entry deleted"; }] };
      else if (I.lv === 2) writer = { name: "Writer (admin edit)", steps: [`DEL ${key}`, `UPDATE products SET price = ${I.neu} WHERE id = ${I.id}`, "sleep 500 ms", `DEL ${key}  -- delayed double delete`], ops: [(s) => { s.cache = null; return "deleted"; }, (s) => { s.db = I.neu; return `price = ${I.neu} (committed)`; }, () => "waiting", (s) => { s.cache = null; return "deleted again"; }] };
      else writer = { name: "Writer (admin edit)", steps: ["BEGIN", `UPDATE products SET price = ${I.neu} WHERE id = ${I.id}`, `DEL ${key}`, "COMMIT"], ops: [() => "transaction open", (s) => { s.pend = I.neu; return `price = ${I.neu} (uncommitted: others still see ${I.old})`; }, (s) => { s.cache = null; return "deleted"; }, (s) => { s.db = s.pend; return "committed"; }] };
      return { init: { db: I.old, cache: I.lv === 1 ? null : I.old, pend: null }, lanes: [reader(I.lv === 2), writer], broken: (r) => r.S.cache != null && r.S.cache !== r.S.db, verdict: (r) => `database says ${r.S.db}, cache says ${r.S.cache == null ? "(empty)" : r.S.cache}${r.S.cache != null && r.S.cache !== r.S.db ? " for the next hour" : ""}` };
    },
    text: (I) => `<p>Product ${I.id}'s price changed from <b>${I.old}</b> to <b>${I.neu}</b>, yet some customers saw the old price for an hour. Reads use cache-aside (miss → read DB → <code>SET</code> with a 1-hour TTL). ${I.lv === 1 ? "Writes update the row, then delete the cache key." : I.lv === 2 ? "After an earlier incident the writer now deletes the key both before and 500 ms after the update (\"delayed double delete\"). The reader pod has occasional 1 s GC pauses." : "The writer deletes the key inside its transaction, right after the UPDATE, \"so the cache is never stale after commit\"."}</p><p><b>Find a schedule that leaves the cache stale.</b></p>`,
    hint: (I) => I.lv === 1 ? "Let the reader fetch the old price, then let the writer finish, then let the reader SET." : I.lv === 2 ? "The delay only helps if the reader is faster than 500 ms." : "What does a concurrent reader see in the database before COMMIT?",
    concept: "Cache-aside invalidation races",
    how: "In cache-aside the reader's SET can land after a writer's DELETE even though it carries a value read before the update; the stale value then lives for the whole TTL. Deleting before the update, or deleting twice with a delay, only narrows the window: a reader that stalls longer than the delay still wins. Deleting before COMMIT is worse, since readers keep seeing the old committed row and re-fill the cache with it. Robust fixes: delete after commit (or from CDC), add version checks (only SET if the version is newer), use leases (a miss hands out a token that a later delete invalidates), and keep TTLs short enough to bound the damage.",
    rule: "Invalidate after commit, make cache fills conditional on a version or lease, and choose a TTL you can live with as the worst case.",
    why: (I) => I.lv === 1 ? `The reader read ${I.old}, the writer updated and deleted, and the reader then cached ${I.old} for an hour.` : I.lv === 2 ? `The reader read ${I.old} and then paused for 1.2 s, longer than the writer's 500 ms delay, so its SET came after both deletes.` : `The delete ran before COMMIT, so a reader that missed the cache still read the committed old price ${I.old} and cached it.`,
  }));

  S.push(ilv({
    id: "data-optimistic-lock",
    name: "Two editors, one page",
    kind: "Code review",
    skills: ["diagnose", "design"],
    gen(lv, R) { return { lv, page: R.int(10, 900), a: R.pick(["Ana", "Ravi", "Mei", "Tom"]), b: R.pick(["Lena", "Omar", "Kofi", "Sara"]), ver: R.int(3, 40) }; },
    model(I) {
      const cond = I.lv === 1 ? "" : I.lv === 2 ? "" : " AND updated_at = :seen_updated_at";
      const lane = (who, edit) => {
        const steps = [`SELECT body, version, updated_at FROM pages WHERE id = ${I.page}`, `${who} edits: ${edit}`];
        const ops = [(s, v) => { v.doc = s.doc.slice(); v.ver = s.ver; v.ts = s.ts; return `reads ${s.doc.length} paragraphs, version ${s.ver}, updated_at ${s.ts}`; }, (s, v) => { v.doc.push(edit); return "local change"; }];
        if (I.lv === 2) { steps.push(`SELECT version FROM pages WHERE id = ${I.page} -- still ${"$"}version?`); ops.push((s, v) => { v.okv = s.ver === v.ver; return v.okv ? "version unchanged: proceed" : "version changed: return 409"; }); }
        steps.push(I.lv === 1 ? `UPDATE pages SET body = :body WHERE id = ${I.page}` : I.lv === 2 ? `UPDATE pages SET body = :body, version = version + 1 WHERE id = ${I.page}` : `UPDATE pages SET body = :body, updated_at = NOW() WHERE id = ${I.page}${cond}`);
        ops.push((s, v) => {
          if (I.lv === 2 && !v.okv) return "skipped (409 shown to user)";
          if (I.lv === 3 && s.ts !== v.ts) return "0 rows updated → 409 Conflict shown to user";
          s.doc = v.doc; if (I.lv === 2) s.ver++; if (I.lv === 3) s.ts = "10:42:07"; return `1 row updated; page has ${s.doc.length} paragraphs`;
        });
        return { name: who, steps, ops };
      };
      const ea = "adds a paragraph", eb = "fixes the intro";
      return { init: { doc: ["intro"], ver: I.ver, ts: "10:42:07" }, lanes: [lane(I.a, ea), lane(I.b, eb)], broken: (r) => !(r.S.doc.includes(ea) && r.S.doc.includes(eb)) && r.S.doc.length > 1, verdict: (r) => (r.S.doc.includes(ea) && r.S.doc.includes(eb)) ? "both edits survived" : r.S.doc.length === 1 ? "no edit saved" : `only "${r.S.doc[r.S.doc.length - 1]}" survived, and nobody was told` };
    },
    text: (I) => `<p>Wiki page ${I.page} is edited by <b>${I.a}</b> and <b>${I.b}</b> at the same moment. ${I.lv === 1 ? "The save endpoint just writes the new body." : I.lv === 2 ? "There's a <code>version</code> column: the handler re-reads it before saving and returns 409 if it changed, then bumps it in the UPDATE." : "The service uses optimistic locking on <code>updated_at</code>. The column is MySQL <code>DATETIME</code> (no fractional seconds); the page was last saved at 10:42:07.2, and both saves happen within the same second."}</p><p><b>Find a schedule where one edit silently disappears</b> (a 409 shown to a user is fine: they can merge).</p>`,
    hint: (I) => I.lv === 1 ? "Both read, then both write." : I.lv === 2 ? "The check and the UPDATE are separate statements." : "What does updated_at look like after a save in the same second?",
    concept: "Optimistic concurrency control",
    how: "Optimistic locking lets readers proceed without locks and detects conflicts at write time: <code>UPDATE … SET body = :b, version = version + 1 WHERE id = :id AND version = :seen</code>, then treat 0 affected rows as a conflict. The check must be inside the same atomic statement as the write; checking with a separate SELECT first is a time-of-check/time-of-use race. The token must change on every write: timestamps with second (or even millisecond) precision can repeat, so two writes in the same tick look identical. An integer version (or a strong ETag) is the reliable token.",
    rule: "Put the version check in the UPDATE's WHERE clause, use a monotonically increasing integer, and surface 0-rows-updated as a 409.",
    why: (I) => I.lv === 1 ? "Both editors read the same body and the second save overwrote the first." : I.lv === 2 ? "Both checks passed before either UPDATE ran, and the UPDATE itself doesn't compare versions, so the second save overwrote the first." : "The first save set updated_at to NOW() truncated to 10:42:07, the same value the second editor had read, so its WHERE clause still matched and it overwrote the page.",
  }));

  S.push(ilv({
    id: "data-unique-race",
    name: "Duplicate sign-ups",
    kind: "Incident",
    skills: ["diagnose", "design"],
    gen(lv, R) { return { lv, email: R.pick(["li.wei", "amara", "jonas.k", "priya", "diego"]) + "@" + R.pick(["example.com", "mail.test"]) }; },
    model(I) {
      const e = I.email;
      if (I.lv < 3) {
        const lane = (n) => ({ name: n, steps: I.lv === 1 ? [`SELECT id FROM users WHERE email = '${e}'`, "if none: INSERT INTO users (email) VALUES (...)"] : ["BEGIN", `SELECT id FROM users WHERE email = '${e}' FOR UPDATE`, "if none: INSERT INTO users (email) VALUES (...)", "COMMIT"],
          ops: I.lv === 1 ? [(s, v) => { v.f = s.rows > 0; return v.f ? "found" : "no row"; }, (s, v) => { if (v.f) return "returns existing user"; s.rows++; return "inserted"; }]
            : [() => "transaction open", (s, v) => { v.f = s.rows > 0; return v.f ? "found and locked the row" : "no row, so nothing is locked"; }, (s, v) => { if (v.f) return "returns existing user"; v.ins = true; return "inserted (uncommitted)"; }, (s, v) => { if (v.ins) s.rows++; return "committed"; }] });
        return { init: { rows: 0 }, lanes: [lane("Request A"), lane("Request B (double-click)")], broken: (r) => r.S.rows > 1, verdict: (r) => `${r.S.rows} user row${r.S.rows === 1 ? "" : "s"} for ${e}` };
      }
      return {
        init: { has: false },
        lanes: [
          { name: "Request A: get-or-create (one statement)", steps: ["statement starts: snapshot taken", `WITH ins AS (INSERT INTO users (email) VALUES ('${e}') ON CONFLICT (email) DO NOTHING RETURNING id)`, `SELECT id FROM ins UNION ALL SELECT id FROM users WHERE email = '${e}'`, "return user id"],
            ops: [(s, v) => { v.snap = s.has; return v.snap ? "snapshot contains the user" : "snapshot has no such user"; }, (s, v) => { if (s.has) { v.ret = null; return "conflict: nothing inserted, ins is empty"; } s.has = true; v.ret = "new id"; return "inserted, ins returns the new id"; }, (s, v) => { if (v.ret) return "returns id from ins"; v.ret = v.snap ? "existing id" : null; return v.ret ? "SELECT finds the existing row" : "SELECT uses the statement's snapshot: the other request's row is invisible → 0 rows"; }, (s, v) => v.ret ? `returns ${v.ret}` : { note: "returns NULL → 500 \"user not found\"", err: true }] },
          { name: "Request B: web sign-up", steps: [`INSERT INTO users (email) VALUES ('${e}')  -- autocommit`, "return 201"], ops: [(s) => { if (s.has) return { note: "ERROR: duplicate key value violates unique constraint \"users_email_key\"", err: true }; s.has = true; return "inserted and committed"; }, () => "done"] },
        ],
        broken: (r) => r.V[0].ret === null,
        verdict: (r) => r.V[0].ret ? `get-or-create returned ${r.V[0].ret}` : "get-or-create returned no row",
      };
    },
    text: (I) => I.lv === 1 ? `<p>Support found two accounts for <code>${I.email}</code>, created 40 ms apart by a double-clicked Sign up button. The handler checks whether the email exists, then inserts. There is no unique constraint on <code>users.email</code>.</p><p><b>Find a schedule that creates the duplicate.</b></p>`
      : I.lv === 2 ? `<p>The fix for duplicate sign-ups wraps the check in a transaction with <code>SELECT … FOR UPDATE</code> \"so the second request waits\". Still no unique constraint (Postgres 16, READ COMMITTED).</p><p><b>Find a schedule that still creates a duplicate.</b></p>`
        : `<p>Now there's a unique constraint on <code>users.email</code>, and the OAuth callback does get-or-create in a single statement (READ COMMITTED). Rarely, the callback returns no user and the login fails with a 500.</p><p><b>Find the schedule that makes get-or-create return nothing.</b></p>`,
    hint: (I) => I.lv === 1 ? "Two checks before two inserts." : I.lv === 2 ? "FOR UPDATE locks rows that exist. What does it lock when there are none?" : "Every part of one statement sees the same snapshot, taken when the statement starts.",
    concept: "Uniqueness belongs in the database",
    how: "Check-then-insert in application code always races: both requests see 'no row' and both insert. <code>SELECT … FOR UPDATE</code> locks only rows that exist, so it can't serialise inserts of a row that doesn't exist yet (Postgres has no gap locks). A unique constraint or unique index is the only reliable guard; let the INSERT fail or use <code>INSERT … ON CONFLICT</code>. Get-or-create has its own trap: inside one statement, every part sees the snapshot taken when the statement began, so the SELECT half can't see a row committed concurrently that blocked the INSERT half. Retry the lookup in a new statement (or use <code>ON CONFLICT DO UPDATE … RETURNING</code>) when it comes back empty.",
    rule: "Enforce uniqueness with a constraint, write get-or-create as INSERT … ON CONFLICT, and handle the empty-result case with a fresh statement.",
    why: (I) => I.lv === 1 ? "Both requests ran their SELECT before either INSERT, so both inserted." : I.lv === 2 ? "Neither SELECT … FOR UPDATE found a row, so neither locked anything, and both inserted." : "Request A's statement took its snapshot, request B committed the user, A's INSERT hit the conflict and inserted nothing, and A's SELECT, using the old snapshot, couldn't see B's row.",
  }));

  S.push(ilv({
    id: "data-consumer-dupe",
    name: "Points credited twice",
    kind: "Incident",
    skills: ["diagnose", "design"],
    gen(lv, R) { return { lv, off: R.int(1000, 90000), pts: R.pick([50, 100, 250, 500]) }; },
    model(I) {
      const m = `#${I.off}`, P = I.pts;
      if (I.lv === 1) return {
        init: { pts: 0, committed: false },
        lanes: [
          { name: "consumer-1", steps: [`poll() → message ${m} (order paid)`, `UPDATE wallets SET points = points + ${P}`, `commitSync(offset ${I.off + 1})`], ops: [(s, v) => { v.got = true; return "got the message"; }, (s) => { s.pts += P; return `points = ${s.pts}`; }, (s) => { s.committed = true; return "offset committed"; }] },
          { name: "Kubernetes", steps: ["consumer-1 pod killed; rebalance gives the partition to consumer-2, which resumes at the last committed offset"], ops: [(s, v, c) => { c.kill(0); if (!s.committed) { const was = s.pts; s.pts += P; s.committed = true; return `consumer-2 re-reads ${m} and processes it: points ${was} → ${s.pts}`; } return "consumer-2 starts after the message"; }] },
        ],
        broken: (r) => r.S.pts > P, verdict: (r) => `wallet credited ${r.S.pts / P}×`,
      };
      if (I.lv === 2) {
        const lane = (n, first) => ({ name: n, steps: [first, `SELECT 1 FROM processed WHERE msg_id = '${I.off}'`, `UPDATE wallets SET points = points + ${P}`, `INSERT INTO processed (msg_id) VALUES ('${I.off}')`],
          ops: [() => "has the message", (s, v) => { v.seen = s.done; return v.seen ? "already processed" : "not processed yet"; }, (s, v) => { if (v.seen) return "skipped"; s.pts += P; return `points = ${s.pts}`; }, (s, v) => { if (v.seen) return "skipped"; if (s.done) return { note: "ERROR: duplicate key (but the points were already added)", err: true }; s.done = true; return "recorded"; }] });
        return { init: { pts: 0, done: false }, lanes: [lane("consumer-1 (stalled 45 s in GC, partition revoked)", `resume handling ${m} after the pause`), lane("consumer-2 (new owner after rebalance)", `poll() → ${m} (offset was never committed)`)], broken: (r) => r.S.pts > P, verdict: (r) => `wallet credited ${r.S.pts / P}×` };
      }
      return {
        init: { pts: 0, done: false, push: 0, committed: false },
        lanes: [
          { name: "consumer-1", steps: [`poll() → ${m}`, "BEGIN", `INSERT INTO processed (msg_id) VALUES ('${I.off}') ON CONFLICT DO NOTHING`, `UPDATE wallets SET points = points + ${P}`, `push.send("You earned ${P} points!")`, "COMMIT", `commitSync(offset ${I.off + 1})`],
            ops: [() => "got it", () => "transaction open", (s, v) => { v.dup = s.done; return v.dup ? "0 rows: already processed" : "1 row (uncommitted)"; }, (s, v) => { if (v.dup) return "skipped"; v.p = true; return "points added (uncommitted)"; }, (s, v) => { if (v.dup) return "skipped"; s.push++; return `notification #${s.push} sent to the phone`; }, (s, v) => { if (!v.dup) { s.done = true; s.pts += P; } return "committed"; }, (s) => { s.committed = true; return "offset committed"; }] },
          { name: "Kubernetes", steps: ["consumer-1 killed; consumer-2 re-reads from the committed offset and runs the same handler"], ops: [(s, v, c) => { c.kill(0); if (s.committed) return "nothing to redo"; if (s.done) { s.committed = true; return "consumer-2: processed row exists → skips, commits offset"; } s.done = true; s.pts += P; s.push++; s.committed = true; return `consumer-2 processes ${m}: points +${P}, notification #${s.push}`; }] },
        ],
        broken: (r) => r.S.pts > P || r.S.push > 1,
        verdict: (r) => `wallet credited ${r.S.pts / P}×, ${r.S.push} notification${r.S.push === 1 ? "" : "s"}`,
      };
    },
    nudge: "Kafka delivers at least once. Where can a redelivery slip through?",
    text: (I) => I.lv === 1 ? `<p>A Kafka consumer credits <b>${I.pts}</b> loyalty points for each paid order, then commits the offset. Customers occasionally get double points after deploys.</p><p><b>Find a schedule that credits the wallet twice.</b></p>`
      : I.lv === 2 ? `<p>The consumer now records processed message ids in a <code>processed</code> table (primary key on <code>msg_id</code>) and checks it first. Each statement autocommits. Double credits still happen during rebalances, when a consumer paused by a long GC keeps working on a partition that has already been reassigned.</p><p><b>Find the schedule.</b></p>`
        : `<p>The dedup insert and the wallet update now share one transaction, so the wallet can't be credited twice. Product also sends a push notification from the handler. Users report duplicate \"You earned points\" pushes.</p><p><b>Find a schedule that produces a duplicate effect the customer can see.</b></p>`,
    hint: (I) => I.lv === 1 ? "Kill the consumer after the UPDATE but before the offset commit." : I.lv === 2 ? "Both consumers check before either records." : "Which effect is outside the transaction?",
    concept: "At-least-once delivery and idempotent consumers",
    how: "Kafka (like most brokers) redelivers anything whose offset wasn't committed, so a crash between doing the work and committing repeats the work. A dedup table only helps if the check and the effect are atomic: put <code>INSERT … ON CONFLICT DO NOTHING</code> on the message id and the state change in the same database transaction, and skip the effect when the insert affected 0 rows. Rebalances can also leave a stalled 'zombie' consumer running alongside the new owner, so the dedup has to be safe under concurrency, not just after crashes. Effects outside the database (emails, pushes, HTTP calls) can't join the transaction: give them their own idempotency key, or write them to an outbox that is sent once.",
    rule: "Make the dedup record and the state change one transaction; route external side effects through an outbox or an idempotency key at the provider.",
    why: (I) => I.lv === 1 ? `The consumer added ${I.pts} points and died before committing its offset, so the new owner processed message #${I.off} again.` : I.lv === 2 ? "Both consumers checked the processed table before either inserted, so both credited the wallet; the unique key only stopped the second bookkeeping row." : `The push went out, then the pod died before COMMIT: the transaction (dedup row and points) rolled back, and the redelivery credited the points once more and sent a second push. Points stayed correct; the push didn't.`,
  }));

  /* ================= steps: migrations ================= */
  // Expand/contract simulator. Versions: A old only, B writes both reads old, C writes both reads new, D new only.
  const EC_VER = { A: { r: "o", w: ["o"] }, B: { r: "o", w: ["o", "n"] }, C: { r: "n", w: ["o", "n"] }, D: { r: "n", w: ["n"] } };
  const ecSteps = (I) => {
    const o = I.old, n = I.neu, t = I.table;
    const s = {
      add: `Migration: ALTER TABLE ${t} ADD COLUMN ${n} ${I.type} (nullable)`,
      depB: `Deploy v2: write both ${o} and ${n}, read ${o}`,
      fill: I.lv === 3 ? `Backfill ${n} from ${o} in batches of 5,000 rows (WHERE ${n} IS NULL)` : `Backfill: UPDATE ${t} SET ${n} = ${I.conv} WHERE ${n} IS NULL`,
      depC: `Deploy v3: write both, read ${n}`,
      depD: `Deploy v4: write and read ${n} only`,
      drop: `Migration: ALTER TABLE ${t} DROP COLUMN ${o}`,
      rename: `Migration: ALTER TABLE ${t} RENAME COLUMN ${o} TO ${n}`,
      depDearly: `Deploy v4 (read/write ${n} only) right after adding the column`,
    };
    if (I.lv >= 2) s.report = `Point the nightly ${I.lv === 2 ? "finance export" : "BI sync"} at ${n}`;
    if (I.lv === 3) {
      s.trig = `CREATE TRIGGER: on INSERT/UPDATE set NEW.${n} = COALESCE(NEW.${n}, ${I.conv.replace(o, "NEW." + o)})`;
      s.untrig = "DROP the sync trigger";
      s.fill1 = `Backfill with one statement: UPDATE ${t} SET ${n} = ${I.conv}`;
    }
    return s;
  };
  function ecSim(I, keys) {
    const st = { cols: new Set(["o"]), run: ["A"], nOk: false, oOk: true, trig: false, report: "o" }, rows = [];
    const name = { A: "v1", B: "v2", C: "v3", D: "v4" }, col = { o: I.old, n: I.neu };
    let fail = null;
    const check = (run) => {
      for (const v of run) {
        const e = EC_VER[v];
        for (const c of [e.r, ...e.w]) if (!st.cols.has(c)) return `${name[v]} fails: ERROR: column "${col[c]}" does not exist`;
      }
      if (I.lv >= 2 && !st.cols.has(st.report)) return `the nightly job fails: column "${col[st.report]}" does not exist`;
      if (st.cols.has("n") && run.some((v) => !EC_VER[v].w.includes("n")) && !st.trig) st.nOk = false;
      if (run.some((v) => !EC_VER[v].w.includes("o"))) st.oOk = false;
      for (const v of run) {
        if (EC_VER[v].r === "n" && !st.nOk) return `${name[v]} reads ${col.n}, but some rows have it NULL (written before the backfill or by an older version): users see blank values`;
        if (EC_VER[v].r === "o" && !st.oOk) return `${name[v]} (still running) reads ${col.o}, but rows written by v4 leave it NULL`;
      }
      if (I.lv >= 2 && st.report === "o" && !st.oOk) return `the nightly job reads ${col.o}, which v4 no longer writes`;
      if (I.lv >= 2 && st.report === "n" && !st.nOk) return `the nightly job now reads ${col.n}, which isn't complete yet`;
      return null;
    };
    for (const k of keys) {
      if (fail) break;
      let note = "";
      if (k === "add") { if (st.cols.has("n")) fail = "column already exists"; else { st.cols.add("n"); st.nOk = false; note = "new column, NULL in every existing row"; } }
      else if (k === "depB" || k === "depC" || k === "depD" || k === "depDearly") {
        const v = k === "depDearly" ? "D" : k.slice(3);
        const during = [...new Set([...st.run, v])];
        fail = check(during);
        if (!fail) { st.run = [v]; fail = check(st.run); note = `rolling deploy: ${during.map((x) => name[x]).join(" + ")} ran side by side`; }
      } else if (k === "fill" || k === "fill1") {
        if (!st.cols.has("n")) fail = `ERROR: column "${col.n}" does not exist`;
        else if (k === "fill1") fail = `one UPDATE over ${I.rows} rows holds row locks for its whole run, bloats the table and floods the replicas with WAL: checkout requests time out`;
        else { st.nOk = true; if (st.run.some((v) => !EC_VER[v].w.includes("n")) && !st.trig) { st.nOk = false; note = `backfill ran, but ${st.run.map((x) => name[x]).join("/")} keeps inserting rows without ${col.n}`; } else note = "every row now has " + col.n; }
      } else if (k === "drop") {
        if (st.trig) fail = `every INSERT now fails: the trigger function still references NEW.${col.o}`;
        else { st.cols.delete("o"); fail = check(st.run); note = "old column gone"; }
      } else if (k === "rename") { st.cols.delete("o"); st.cols.add("n"); st.nOk = true; fail = check(st.run); }
      else if (k === "report") { st.report = "n"; fail = check(st.run); note = "job reads " + col.n; }
      else if (k === "trig") { if (!st.cols.has("n")) fail = `ERROR: column "${col.n}" does not exist`; else { st.trig = true; note = "rows written by old code get " + col.n + " too"; } }
      else if (k === "untrig") { st.trig = false; fail = check(st.run); note = "trigger dropped"; }
      if (!fail) fail = check(st.run);
      rows.push({ k, note, fail });
    }
    const done = !fail && st.run.length === 1 && st.run[0] === "D" && !st.cols.has("o") && (I.lv < 2 || st.report === "n") && !st.trig;
    return { rows, fail, done, st };
  }
  S.push({
    id: "data-expand-contract",
    name: "Rename a column under a rolling deploy",
    kind: "Change plan",
    skills: ["safe", "design"],
    w: "steps",
    gen(lv, R) {
      const c = lv === 1 ? { table: "users", old: "fullname", neu: "display_name", type: "text", conv: "fullname", rows: "4M" }
        : lv === 2 ? { table: "orders", old: "amount", neu: "amount_cents", type: "bigint", conv: "round(amount * 100)", rows: "60M" }
          : { table: R.pick(["events", "shipments"]), old: "payload", neu: "payload_v2", type: "jsonb", conv: "payload::jsonb", rows: "400M" };
      const keys = Object.keys(ecSteps({ ...c, lv }));
      return { lv, ...c, keys: R.shuffle(keys) };
    },
    text: (I) => `<p>You need to replace <code>${I.table}.${I.old}</code> with <code>${I.neu}</code> (${I.type}${I.lv === 2 ? ", integer cents" : ""}). The service deploys by rolling update, so for a few minutes the old and new versions serve traffic side by side. The table has ${I.rows} rows.${I.lv >= 2 ? ` A nightly job also reads <code>${I.old}</code>.` : ""}${I.lv === 3 ? " A database trigger is an option instead of shipping a dual-write release." : ""}</p><p><b>Build a plan that ends with only <code>${I.neu}</code> in the schema and the newest app version running, without a single failed request or blank value.</b> The panel simulates each step, including both versions running mid-deploy.</p>`,
    ui: (I) => { const s = ecSteps(I); return { opts: I.keys.map((k) => s[k]), live: (seq) => {
      if (!seq || !seq.length) return `<p class="muted small">Pick steps to simulate them.</p>`;
      const keys = seq.map((i) => I.keys[i]), r = ecSim(I, keys);
      return K.table(["#", "step", "result"], r.rows.map((x, j) => [String(j + 1), esc(s[x.k]), x.fail ? `<span class="lose">${esc(x.fail)}</span>` : esc(x.note || "ok")]), { compact: true }) + (r.fail ? K.verdict(false, "This plan breaks production.") : r.done ? K.verdict(true, "Migration complete with zero errors.") : `<p class="muted small">So far so good. Running: v${{ A: 1, B: 2, C: 3, D: 4 }[r.st.run[0]]}; columns: ${[...r.st.cols].map((c) => (c === "o" ? I.old : I.neu)).join(", ")}.</p>`);
    } }; },
    accept(I, seq) {
      const r = ecSim(I, seq.map((i) => I.keys[i]));
      if (r.fail) return "Production breaks: " + esc(r.fail) + ".";
      if (!r.done) return `No errors, but you're not finished: ${r.st.cols.has("o") ? `<code>${I.old}</code> is still in the schema` : r.st.trig ? "the sync trigger is still installed" : r.st.run[0] !== "D" ? "the newest version isn't the only one running" : "the nightly job still needs moving"}.`;
      return true;
    },
    solve(I) { const ks = I.lv === 1 ? ["add", "depB", "fill", "depC", "depD", "drop"] : I.lv === 2 ? ["add", "depB", "fill", "depC", "report", "depD", "drop"] : ["add", "trig", "fill", "depC", "report", "depD", "untrig", "drop"]; return ks.map((k) => I.keys.indexOf(k)); },
    bad(I) { const x = (ks) => ks.map((k) => I.keys.indexOf(k)); return [x(["rename"]), x(["add", "depDearly", "fill", "drop"]), x(["add", "fill", "depB", "depC", "depD", "drop"]), ...(I.lv === 3 ? [x(["add", "trig", "fill1", "depC", "report", "depD", "untrig", "drop"]), x(["add", "trig", "fill", "depC", "report", "depD", "drop"])] : [])]; },
    hint: (I) => I.lv === 1 ? "Expand (add, dual-write, backfill), migrate reads, then contract. A version that writes only the new column must never run next to one that reads the old column." : I.lv === 2 ? "The nightly job is a reader too: it has to move before anything stops writing the old column." : "A trigger can stand in for dual-writing code, but think about what references it before you drop the old column, and how big one UPDATE would be.",
    concept: "Expand/contract (parallel change) migrations",
    how: "During a rolling deploy two app versions share one schema, so every schema change must work for both. Expand first: add the new column, ship code that writes both (or a trigger that copies), backfill old rows in small batches, then switch reads to the new column. Contract last: stop writing the old column only once nothing reads it, then drop it. A rename or type change in one step breaks whichever version is still running. Each stage is a separate deploy, so each can be rolled back on its own.",
    rule: "Never change a column the running code uses: add, dual-write, backfill, switch reads, stop writes, drop, each as its own deploy.",
    why: (I) => `The safe order here: ${I.lv === 3 ? "add the column, install the COALESCE trigger so v1 rows get it, backfill in batches, switch reads (v3), move the BI sync, ship v4, drop the trigger and only then drop the old column" : `add the column, dual-write with v2, backfill, read the new column in v3${I.lv === 2 ? ", move the finance export" : ""}, write only the new column in v4, then drop ${I.old}`}. Skipping v3 fails because v2 (reading ${I.old}) would run next to v4 (not writing it).`,
  });

  const DM = {
    dual: "Deploy dual-write: DocStore stays primary; also write Postgres, logging any failed secondary write for repair",
    fill: "Backfill historical documents into Postgres with idempotent upserts by id",
    recon: "Run a reconciliation job comparing both stores; fix diffs until mismatches stay at 0",
    shadow: "Shadow reads: serve from DocStore, also read Postgres and log every mismatch",
    flipR: "Flip reads to Postgres behind a flag, ramping 1% → 100%",
    flipW: "Make Postgres the primary write; keep writing DocStore as the secondary for rollback",
    stop: "Stop writing to DocStore",
    decom: "Decommission DocStore after the rollback window",
    t1: "Backfill first, then deploy dual-write",
    t2: "Big-bang cutover during a 6-hour maintenance window",
    t3: "Flip reads to Postgres and stop DocStore writes in the same deploy",
    t4: "Delete DocStore data as soon as reads are flipped",
  };
  const dmReq = (lv) => lv === 1 ? ["dual", "fill", "recon", "flipR", "stop", "decom"] : lv === 2 ? ["dual", "fill", "recon", "shadow", "flipR", "stop", "decom"] : ["dual", "fill", "recon", "shadow", "flipR", "flipW", "stop", "decom"];
  const DM_BEFORE = { fill: ["dual"], recon: ["fill"], shadow: ["fill"], flipR: ["recon", "shadow"], flipW: ["flipR"], stop: ["flipR", "flipW"], decom: ["stop"] };
  const DM_TRAP = { t1: "Rows written between the backfill and the dual-write deploy exist only in DocStore: silent data loss.", t2: "A 6-hour outage for a store with 24/7 traffic, and no way back once writes land in Postgres.", t3: "Flipping and stopping together removes your rollback: if Postgres reads are wrong you can't go back without losing writes.", t4: "Deleting the old data before the rollback window ends means a bad flip is unrecoverable." };
  function dmCheck(I, keys) {
    const need = dmReq(I.lv), seen = new Set();
    for (const k of keys) {
      if (!k) return "Pick steps from the list.";
      if (DM_TRAP[k]) return DM_TRAP[k];
      if (!need.includes(k)) return `"${DM[k]}" isn't needed here.`;
      for (const b of DM_BEFORE[k] || []) if (need.includes(b) && !seen.has(b)) return `"${DM[k]}" comes too early: it needs "${DM[b]}" first.`;
      seen.add(k);
    }
    const miss = need.filter((k) => !seen.has(k));
    if (miss.length) return `Missing: "${DM[miss[0]]}".`;
    return true;
  }
  S.push({
    id: "data-store-migration",
    name: "Move a live service to a new database",
    kind: "Change plan",
    skills: ["safe", "design"],
    w: "steps",
    gen(lv, R) { const ks = dmReq(lv).concat(lv === 1 ? ["t1", "t2"] : lv === 2 ? ["t1", "t3", "t2"] : ["t1", "t3", "t4"]); if (lv < 3) ks.push(lv === 1 ? "shadow" : "flipW"); return { lv, svc: R.pick(["profile", "catalog", "notify", "reviews"]), docs: R.pick([80, 140, 260]) + "M", keys: R.shuffle(ks) }; },
    text: (I) => `<p>The <code>${I.svc}</code> service keeps ${I.docs} documents in a legacy document store (\"DocStore\") that you're replacing with Postgres. It serves traffic 24/7 and can't lose writes.${I.lv >= 2 ? " The data model changes shape on the way, so you don't trust the converter yet." : ""}${I.lv === 3 ? " Leadership also wants a tested rollback path <i>after</i> Postgres becomes the system of record." : ""}</p><p><b>Order the steps for a zero-downtime migration.</b> Leave out steps that aren't needed.</p>`,
    ui: (I) => ({ opts: I.keys.map((k) => DM[k]), live: (seq) => {
      if (!seq || !seq.length) return "";
      const keys = seq.map((i) => I.keys[i]);
      let reads = "DocStore", writes = "DocStore";
      const rows = keys.map((k) => { if (k === "dual") writes = "DocStore → Postgres"; if (k === "flipR") reads = "Postgres"; if (k === "flipW") writes = "Postgres → DocStore"; if (k === "stop") writes = writes.startsWith("Postgres") ? "Postgres" : "Postgres"; if (k === "t2") { reads = writes = "Postgres"; } if (k === "t3") { reads = "Postgres"; writes = "Postgres"; } return [esc(DM[k]), reads, writes]; });
      return K.table(["step", "reads from", "writes to (primary → secondary)"], rows, { compact: true });
    } }),
    accept: (I, seq) => dmCheck(I, seq.map((i) => I.keys[i])),
    solve: (I) => dmReq(I.lv).map((k) => I.keys.indexOf(k)),
    bad: (I) => { const x = (ks) => ks.map((k) => I.keys.indexOf(k)); const r = dmReq(I.lv); return [x(["t1", ...r.filter((k) => k !== "dual" && k !== "fill")]), x([I.keys.find((k) => /^t[234]$/.test(k))]), x(r.slice().reverse())]; },
    hint: (I) => I.lv === 1 ? "Start capturing new writes before copying old ones, and verify before anyone reads from the new store." : I.lv === 2 ? "Reconciliation compares data; shadow reads compare what users would actually see through the new code path." : "Rollback after the write flip needs the old store to keep receiving writes.",
    concept: "Online datastore migration",
    how: "Live migrations follow a pattern: dual-write (old store primary) so new changes reach both, backfill history with idempotent upserts, reconcile until the stores agree, shadow-read to compare real query results, then ramp reads behind a flag. Flipping the primary write while still writing the old store as secondary keeps a rollback path. Only after a rollback window do you stop old writes and decommission. Starting the backfill before dual-writes leaves a gap; doing several flips in one deploy removes your escape hatch.",
    rule: "Each migration step should be observable and reversible on its own: dual-write, backfill, verify, shadow, ramp reads, flip writes, and only then turn the old store off.",
    why: (I) => `The plan is ${dmReq(I.lv).map((k) => DM[k].split(":")[0].split(",")[0].toLowerCase()).join(" → ")}.`,
  });

  /* ================= lines: code review ================= */
  S.push(flag({
    id: "data-money-float",
    name: "Find the cent that went missing",
    kind: "Code review",
    skills: ["diagnose"],
    gen(lv, R) { return { lv, cart: R.int(1000, 9999), ccy: R.pick(["JPY", "KRW"]) }; },
    diff(I) {
      if (I.lv === 1) return { file: "src/checkout/charge.ts", lines: [
        dl("@", "@@ -18,9 +18,11 @@ export function chargeAmount(cart: Cart): number {"),
        dl(" ", "  const items = cart.items.filter((i) => !i.removed);", false, "Filtering doesn't touch amounts."),
        dl("-", "  let cents = 0;"), dl("-", "  for (const i of items) cents += i.priceCents * i.qty;"),
        dl("+", "  let total = 0;", false, "Initialising a number is harmless by itself."),
        dl("+", "  for (const i of items) total += (i.priceCents / 100) * i.qty;", true),
        dl("+", "  total -= (cart.discountCents ?? 0) / 100;", "opt"),
        dl("+", "  const cents = Math.trunc(total * 100);", true),
        dl("+", "  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(\"bad amount\");", false, "A defensive check, and a good one."),
        dl(" ", "  metrics.histogram(\"cart.items\", items.length);", false, "A metric of item count."),
        dl(" ", "  return cents;", false, "Returning integer cents is the right contract.") ] };
      if (I.lv === 2) return { file: "src/refunds/split.ts", lines: [
        dl("@", "@@ -40,12 +40,14 @@ export function splitRefund(req: RefundRequest, methods: PaymentMethod[]) {"),
        dl("+", "  // req.amount arrives in major units from the public API, e.g. 12.50 or 1500", false, "A comment."),
        dl("+", "  const minor = Math.round(req.amount * 100);", true),
        dl("+", "  const n = methods.length;", false, "Just a count."),
        dl("+", "  const share = Math.round(minor / n);", true),
        dl("+", "  return methods.map((m) => ({ method: m.id, amountMinor: share, currency: req.currency }));", "opt"),
        dl(" ", "}"),
        dl(" ", ""),
        dl(" ", "export const toMajor = (minor: number, exp: number) => minor / 10 ** exp;  // display only", false, "Converting to major units for display is fine."),
        dl(" ", "export const exponent = (ccy: string) => CURRENCY_EXPONENT[ccy] ?? 2;", false, "Looking up the currency's minor-unit exponent (ISO 4217) is exactly right.") ] };
      return { file: "billing/invoice.py + migrations/0042_amounts.sql", lines: [
        dl("@", "@@ billing/invoice.py @@"),
        dl(" ", "from decimal import Decimal, ROUND_HALF_UP", false, "Using Decimal is the right idea."),
        dl("+", "lines = json.loads(body)[\"lines\"]", "opt"),
        dl("+", "subtotal = sum(Decimal(l[\"unit_price\"]) * l[\"qty\"] for l in lines)", true),
        dl("+", "tax = (subtotal * Decimal(\"0.0825\")).quantize(Decimal(\"0.01\"), rounding=ROUND_HALF_UP)", false, "Decimal from a string, explicit rounding mode, quantized to cents: correct."),
        dl("+", "total = subtotal + tax", false, "Decimal + Decimal is exact."),
        dl("@", "@@ migrations/0042_amounts.sql @@"),
        dl("+", "ALTER TABLE invoices ALTER COLUMN total TYPE double precision;  -- faster SUM()", true),
        dl("+", "ALTER TABLE invoices ADD COLUMN currency char(3) NOT NULL DEFAULT 'USD';", false, "Storing the currency next to the amount is good practice.") ] };
    },
    text: (I) => I.lv === 1 ? `<p>Finance found carts charged one cent less than the receipt shows, e.g. a single item at $0.29 charged as 28¢. This refactor shipped last week. <b>Flag the lines that cause wrong amounts.</b></p>`
      : I.lv === 2 ? `<p>A refund-splitting change is in review. Refunds can be spread over up to three payment methods, and the service handles USD, EUR and ${I.ccy}. <b>Flag the lines that will produce wrong amounts.</b></p>`
        : `<p>The invoicing service is being rewritten in Python. The API body is JSON like <code>{"lines":[{"unit_price": 19.99, "qty": 3}]}</code>. <b>Flag the lines that will make invoice totals drift.</b></p>`,
    hint: (I) => I.lv === 1 ? "0.29 * 100 in IEEE 754 is 28.999999999999996." : I.lv === 2 ? "Not every currency has two decimals, and 1000 / 3 doesn't divide evenly." : "What is Decimal(19.99)? And what type does the column become?",
    concept: "Money as integers (or decimals), never binary floats",
    how: "Binary floating point can't represent most decimal fractions exactly (0.1, 0.29, 19.99), so arithmetic drifts and truncation turns 28.999999999999996 into 28. Store and compute money as integer minor units (cents) or as an exact decimal type (Postgres <code>numeric</code>, Python <code>Decimal</code> built from strings). The minor-unit exponent depends on the currency (ISO 4217: JPY and KRW have 0, USD 2, KWD 3). When splitting, compute shares with integer division and hand the remainder out cent by cent so the parts sum to the total.",
    rule: "Money is an integer of minor units plus a currency code; convert to decimals only for display, and allocate remainders explicitly.",
    why: (I) => I.lv === 1 ? "Converting cents to float dollars and back with Math.trunc loses a cent whenever the float lands just below the integer." : I.lv === 2 ? `Multiplying by 100 assumes two decimals: a ¥1,500 refund in ${I.ccy} becomes 150,000 minor units. And Math.round(minor / n) makes shares that don't sum to the total (1,000 / 3 → 333 × 3 = 999).` : "json.loads parses 19.99 as a float, so Decimal(19.99) carries the binary error (19.989999999999998436…); parse with parse_float=Decimal or send strings. The migration then throws exactness away by storing totals as double precision; keep numeric.",
  }));

  S.push(flag({
    id: "data-n-plus-one",
    name: "The export that runs 4,000 queries",
    kind: "Code review",
    skills: ["diagnose", "tune"],
    gen(lv, R) { return { lv, n: R.int(800, 4000) }; },
    diff(I) {
      if (I.lv === 1) return { file: "reports/views.py", lines: [
        dl("@", "@@ def export_orders(request): @@"),
        dl("+", "    orders = Order.objects.filter(created__date=today())", false, "One query for the orders."),
        dl("+", "    rows = [[\"id\", \"customer_id\", \"email\", \"total\"]]", false, "Just a header row."),
        dl("+", "    for o in orders:", false, "Iterating the queryset runs the single orders query."),
        dl("+", "        rows.append([o.id, o.customer_id, o.customer.email, o.total])", true),
        dl("+", "    return csv_response(rows)", false, "Rendering the CSV.") ] };
      if (I.lv === 2) return { file: "orders/serializers.py", lines: [
        dl("@", "@@ def order_summaries(customer): @@"),
        dl("+", "    orders = customer.orders.prefetch_related(\"items\").order_by(\"-created\")[:50]", false, "Two queries: orders, then all their items."),
        dl("+", "    out = []", false, "A list."),
        dl("+", "    for o in orders:", false, "Iterating the evaluated queryset."),
        dl("+", "        items = o.items.all()", false, "Served from the prefetch cache."),
        dl("+", "        live = o.items.filter(refunded=False)", true),
        dl("+", "        out.append({\"id\": o.id, \"n\": o.items.count(), \"live\": len(live),", false, "count() on a prefetched relation uses the cached results."),
        dl("+", "                    \"city\": o.shipping_address.city})", true),
        dl("+", "    return out") ] };
      return { file: "graphql/resolvers.ts", lines: [
        dl("@", "@@ export const resolvers = { @@"),
        dl("+", "  Query: { feed: (_, { first }, ctx) => ctx.db.post.findMany({ take: first, orderBy: { id: \"desc\" } }) },", false, "One query for the page of posts."),
        dl("+", "  Post: {", false, ""),
        dl("+", "    author: (post, _, ctx) => ctx.loaders.user.load(post.authorId),", false, "DataLoader batches all author lookups in one tick into one query."),
        dl("+", "    commentCount: (post, _, ctx) => ctx.db.comment.count({ where: { postId: post.id } }),", true),
        dl("+", "    tags: (post, _, ctx) => ctx.loaders.tagsByPost.load(post.id),", false, "Batched by a loader."),
        dl("+", "    likedByMe: (post, _, ctx) => ctx.db.like.findFirst({ where: { postId: post.id, userId: ctx.user.id } }).then(Boolean),", true),
        dl("+", "  },"),
        dl("+", "};"),
        dl(" ", "// context.ts: loaders = makeLoaders(db) is created per request", false, "Per-request loaders are correct: no cross-user caching.") ] };
    },
    text: (I) => {
      const log = I.lv === 1 ? `SELECT ... FROM orders WHERE created::date = '2026-10-11'\nSELECT ... FROM customers WHERE id = 412 LIMIT 21\nSELECT ... FROM customers WHERE id = 98 LIMIT 21\n... (${I.n} more like this)` : I.lv === 2 ? `SELECT ... FROM orders WHERE customer_id = 7 ORDER BY created DESC LIMIT 50\nSELECT ... FROM order_items WHERE order_id IN (...)\nSELECT ... FROM order_items WHERE order_id = 9911 AND NOT refunded\nSELECT ... FROM addresses WHERE id = 3120 LIMIT 21\n... (96 more)` : `query Feed { feed(first: 50) { author { name } commentCount tags likedByMe } }\n→ 103 SQL statements, p95 640 ms`;
      return `<p>The database team flagged this endpoint: its query log looks like this.</p>${K.pre(log)}<p><b>Flag every line that issues one query per row.</b></p>`;
    },
    hint: (I) => I.lv === 1 ? "Accessing a foreign-key id is free; following the relation is not." : I.lv === 2 ? "A prefetch caches .all(); a new filter is a new query. Which relations weren't prefetched at all?" : "Which field resolvers talk to the database directly instead of through a loader?",
    concept: "N+1 queries",
    how: "ORMs load relations lazily: touching <code>o.customer</code> on each of N rows issues N extra queries after the first one. The fix is to fetch relations in bulk: a JOIN (<code>select_related</code>), a second IN-list query (<code>prefetch_related</code>), or a per-request batching loader (DataLoader) in GraphQL. Prefetch caches only the exact relation you asked for: filtering it again builds a new query, and unprefetched foreign keys still go one by one. Query-count assertions in tests (django-assert-num-queries, or counting statements per request) catch regressions.",
    rule: "Count queries per request in tests and dashboards, bulk-load every relation a loop touches, and filter prefetched rows in memory.",
    why: (I) => I.lv === 1 ? `<code>o.customer.email</code> loads each customer separately: ${I.n} queries for ${I.n} orders. <code>select_related("customer")</code> makes it one JOIN; <code>o.customer_id</code> was already free.` : I.lv === 2 ? "<code>o.items.filter(refunded=False)</code> ignores the prefetch and queries per order, and <code>o.shipping_address</code> was never select_related. Filter the prefetched items in Python and add select_related(\"shipping_address\")." : "commentCount and likedByMe query once per post (2 × 50 statements). Give them loaders that batch by postId, like author and tags.",
  }));

  S.push(flag({
    id: "data-pii-logs",
    name: "Personal data in the logs",
    kind: "Code review",
    skills: ["safe", "diagnose"],
    gen(lv, R) { return { lv, svc: R.pick(["accounts", "auth", "billing", "profile"]) }; },
    diff(I) {
      if (I.lv === 1) return { file: `${I.svc}/signup.py`, lines: [
        dl("@", "@@ def signup(req): @@"),
        dl("+", "    log.debug(\"signup payload %s\", req.json())", true),
        dl("+", "    user = create_user(req.json())", false, "No logging."),
        dl("+", "    log.info(\"signup ok\", extra={\"user_id\": user.id, \"plan\": user.plan})", false, "An internal id and a plan name aren't personal data on their own."),
        dl("+", "    log.info(\"welcome email queued\", extra={\"to\": user.email})", true),
        dl("+", "    metrics.incr(\"signup\", tags={\"country\": user.country})", false, "A country tag on a counter is aggregate data.") ] };
      if (I.lv === 2) return { file: `${I.svc}/middleware.py`, lines: [
        dl("@", "@@ class AccessLog: @@"),
        dl("+", "    log.info(\"%s %s\", request.method, request.url)  # e.g. /reset?token=...", true),
        dl("+", "    log.debug(\"headers %s\", dict(request.headers))", true),
        dl("+", "    log.info(\"status=%s dur_ms=%d request_id=%s\", resp.status, dur, request_id)", false, "Status, duration and a request id are the right things to log."),
        dl("+", "    if resp.status >= 500:", false, ""),
        dl("+", "        log.error(\"upstream failed\", extra={\"route\": request.route_name})", false, "A route name is fine.") ] };
      return { file: `${I.svc}/observability.py`, lines: [
        dl("@", "@@ def instrument(app): @@"),
        dl("+", "    sentry_sdk.init(dsn=DSN, send_default_pii=True)", true),
        dl("+", "    log.info(\"login\", extra={\"email_hash\": hashlib.sha256(email.encode()).hexdigest()})", true),
        dl("+", "    span.set_attribute(\"http.request.body\", body)", true),
        dl("+", "    span.set_attribute(\"user.id\", user.id)", false, "An opaque internal id is how you correlate without copying personal data."),
        dl("+", "    log.info(\"login ok\", extra={\"ip\": request.client_ip})", "opt"),
        dl("+", "    log.info(\"login ok\", extra={\"user_id\": user.id, \"mfa\": user.mfa_method})", false, "Fine.") ] };
    },
    text: (I) => `<p>A privacy review of the <code>${I.svc}</code> service found that logs and traces are kept for 30 days in a third-party tool that half the company can read, and nothing in them can be deleted on a user's request. <b>Flag the new lines that put personal data or secrets into logs or traces.</b></p>`,
    hint: (I) => I.lv === 1 ? "What's in a sign-up payload?" : I.lv === 2 ? "Where do reset tokens and session cookies travel?" : "A hash of an email isn't anonymous, and traces and error trackers are logs too.",
    concept: "Keeping PII out of logs",
    how: "Logs are copied to many systems, kept for weeks, readable by many people, and can't be selectively erased, so personal data there turns every GDPR erasure into an impossible job and every log viewer into a data processor. Log stable internal ids instead and look details up in the database when needed. URLs carry tokens, headers carry cookies and bearer tokens, request bodies carry passwords and cards. An unsalted hash of an email is still personal data: anyone can hash a list of emails and match. Error trackers and tracing attributes need the same scrubbing (e.g. Sentry's send_default_pii=False, span attribute allow-lists).",
    rule: "Log ids, not people: allow-list fields at the logger, scrub URLs and headers, and treat traces and error reports as logs.",
    why: (I) => I.lv === 1 ? "The sign-up payload contains the password and email, and the second line logs the email directly." : I.lv === 2 ? "Full URLs include the password-reset token in the query string, and request headers include the session cookie and Authorization header." : "send_default_pii=True ships user IPs, cookies and request data to Sentry; an unsalted SHA-256 of an email can be reversed by hashing candidate emails; and the request body goes into every trace. The IP address is personal data too, so keep it only where you have a reason and a retention limit.",
  }));

  S.push(flag({
    id: "data-tz-review",
    name: "The 02:30 job that ran twice",
    kind: "Code review",
    skills: ["diagnose"],
    gen(lv, R) { return { lv, zone: lv === 3 ? "Europe/Berlin" : R.pick(["America/New_York", "America/Chicago"]) }; },
    diff(I) {
      if (I.lv === 1) return { file: "reminders/service.py", lines: [
        dl("@", "@@ def create_reminder(user, when_local: str): @@"),
        dl("+", "    created_at = datetime.now()", true),
        dl("+", "    expires_at = datetime.now(timezone.utc) + timedelta(hours=24)", false, "An aware UTC instant plus 24 hours is exactly 24 hours later."),
        dl("+", `    due = datetime.fromisoformat(when_local).replace(tzinfo=ZoneInfo(user.tz))  # e.g. "${I.zone}"`, false, "Attaching the user's IANA zone to their local wall time is right."),
        dl("+", "    db.insert(created_at=created_at, expires_at=expires_at, due_utc=due.astimezone(timezone.utc), tz=user.tz)", false, "Storing UTC plus the zone name is the recommended shape.") ] };
      if (I.lv === 2) return { file: "billing/schedule.py", lines: [
        dl("@", "@@ def schedule_daily_report(account): @@"),
        dl("+", `    # report at 09:00 local time every day; account.tz = "${I.zone}"`, false, ""),
        dl("+", "    offset = datetime.now(ZoneInfo(account.tz)).strftime(\"%z\")   # e.g. -0400", true),
        dl("+", "    db.save(account.id, local_time=\"09:00\", utc_offset=offset)", "opt"),
        dl("@", "@@ def next_run(last_run_utc): @@"),
        dl("+", "    return last_run_utc + timedelta(days=1)", true),
        dl("+", "    # stored as timestamptz; compared against now() in UTC", false, "") ] };
      return { file: "jobs/cleanup.py", lines: [
        dl("@", "@@ def nightly_window(day: date): @@"),
        dl("+", "    tz = pytz.timezone(\"Europe/Berlin\")", false, "Getting the zone object is fine."),
        dl("+", "    start = datetime(day.year, day.month, day.day, 2, 30, tzinfo=tz)", true),
        dl("+", "    end = start + timedelta(hours=1)", "opt"),
        dl("+", "    log.info(\"window %s → %s\", start.isoformat(), end.isoformat())", false, "Logging is fine."),
        dl("+", "    now = datetime.now().astimezone()", true),
        dl("+", "    return start <= now < end", false, "Comparing two aware datetimes compares instants.") ] };
    },
    text: (I) => I.lv === 1 ? `<p>Reminders are created by an API running on servers whose clock is set to UTC, but the old cron hosts used local time. Analytics shows <code>created_at</code> off by hours for some rows. <b>Flag the line(s) that produce wrong times.</b></p>`
      : I.lv === 2 ? `<p>Customers in ${I.zone} got their \"09:00\" daily report at 10:00 for months after the November DST change. <b>Flag the lines that cause it.</b></p>`
        : `<p>A cleanup job must run in the 02:30–03:30 Berlin window each night. Logs show the window starting at <code>02:30:00+00:53</code>, and on 2026-03-29 (DST starts at 02:00, clocks jump to 03:00) it never ran. <b>Flag the lines that are wrong.</b></p>`,
    hint: (I) => I.lv === 1 ? "Which datetime has no time zone at all?" : I.lv === 2 ? "An offset is a snapshot of today's rule; one UTC day isn't one local day across DST." : "pytz zones must be attached with localize(); and what zone does astimezone() with no argument use?",
    concept: "Time zones: instants vs wall-clock times",
    how: "Past events are instants: store them in UTC (timestamptz) and convert for display. Future local events (a 09:00 report, an appointment) are wall-clock times in a place: store the local time plus an IANA zone name and compute the instant when needed, because offsets change with DST and with law. Adding 24 hours in UTC drifts by an hour across a DST change; add one calendar day in the local zone instead. Naive datetimes take the meaning of whatever machine runs them. With pytz, passing tzinfo= to the constructor gives the zone's first historical offset (LMT, +00:53 for Berlin); use localize(), or the standard library's zoneinfo. Local times can also not exist (spring forward) or happen twice (fall back), so schedulers need a rule for both.",
    rule: "Store instants in UTC, store future local schedules as local time + IANA zone, never use naive datetimes, and decide what happens in the DST gap and overlap.",
    why: (I) => I.lv === 1 ? "datetime.now() is naive server-local time: on the old local-time hosts it's not UTC, and nothing records which it was." : I.lv === 2 ? "Saving today's offset (-0400) freezes summer time forever, and last_run_utc + 1 day keeps the UTC hour fixed, so the local hour shifts when DST ends. Store \"09:00\" with the zone name and compute each run in that zone." : "tzinfo=pytz.timezone(...) yields the LMT offset +00:53, so the window is wrong every night; and datetime.now().astimezone() uses the host's zone, not Berlin. On 2026-03-29, 02:30 Berlin doesn't exist; decide explicitly to run at 03:00 or skip.",
  }));

  S.push(flag({
    id: "data-retry-review",
    name: "Review the retry helper",
    kind: "Code review",
    skills: ["diagnose", "safe"],
    gen(lv, R) { return { lv, dep: R.pick(["inventory", "payments", "shipping", "pricing"]) }; },
    diff(I) {
      if (I.lv === 1) return { file: "src/clients/retry.ts", lines: [
        dl("@", "@@ export async function withRetry<T>(fn: () => Promise<T>): Promise<T> { @@"),
        dl("+", "  for (let attempt = 0; ; attempt++) {", true),
        dl("+", "    try { return await fn(); }", false, "Calling the function."),
        dl("+", "    catch (err) {", false, ""),
        dl("+", "      log.warn({ err, attempt }, \"retrying\");", false, "Logging attempts is good."),
        dl("+", "      await sleep(100);", "opt"),
        dl("+", "      continue;  // any error: 400s, 404s, timeouts...", true),
        dl("+", "    }"),
        dl("+", "  }") ] };
      if (I.lv === 2) return { file: `src/clients/${I.dep}.ts`, lines: [
        dl("@", "@@ async create(order: Order) { @@"),
        dl("+", "  return withRetry(async (attempt) => {", false, ""),
        dl("+", `    const res = await http.post("/v1/${I.dep === "payments" ? "charges" : "reservations"}", { json: order.payload() });`, true),
        dl("+", "    if (res.status === 429) { await sleep(Number(res.headers.get(\"retry-after\"))); throw new Retryable(); }", true),
        dl("+", "    if (res.status >= 500) throw new Retryable();", false, "5xx is a reasonable retry trigger, given an idempotent request."),
        dl("+", "    if (res.status >= 400) throw new Fatal(res.status);", false, "Not retrying 4xx is correct."),
        dl("+", "    return res.json();", false, ""),
        dl("+", "  }, { attempts: 4, delay: (a) => 200 * 2 ** a });", true) ] };
      return { file: "src/checkout/handler.ts", lines: [
        dl("@", "@@ router.post(\"/checkout\", withRetry(async (req, res) => { // edge gateway also retries 5xx twice @@"),
        dl("+", `  const r = await withRetry(() => ${I.dep}.reserve(req.body.items, { idempotencyKey: req.id }), { attempts: 3 });`, true),
        dl("+", "  const deadline = req.deadline;  // 2 s from the client", false, ""),
        dl("+", "  const p = await withRetry(() => pricing.quote(req.body, { timeoutMs: 2000 }), { attempts: 3, retryOn: [\"DEADLINE_EXCEEDED\"] });", true),
        dl("+", "  const delay = (a: number) => Math.random() * Math.min(5000, 100 * 2 ** a);  // full jitter", false, "Capped exponential backoff with full jitter is the recommended shape."),
        dl("+", "  res.json({ reservation: r.id, total: p.total });", false, ""),
        dl("+", "}));", true) ] };
    },
    text: (I) => I.lv === 1 ? `<p>A shared retry helper is going into every HTTP client. During yesterday's ${I.dep} outage it kept the outage going after ${I.dep} recovered. <b>Flag the lines that make it dangerous.</b></p>`
      : I.lv === 2 ? `<p>The ${I.dep} client gets retries. The provider returns <code>Retry-After</code> in <b>seconds</b>, and has asked customers to stop hammering it in synchronised waves. <b>Flag the lines that will hurt.</b></p>`
        : `<p>Checkout's p99 is fine until ${I.dep} slows down; then load on ${I.dep} jumps 20×. The edge gateway already retries 5xx twice. <b>Flag the lines that multiply load or waste work.</b></p>`,
    hint: (I) => I.lv === 1 ? "When does this loop stop, and which errors deserve a retry?" : I.lv === 2 ? "Retrying a POST needs something; Retry-After's unit; and what makes clients spread out?" : "Retries at several layers multiply. And is retrying worthwhile once the caller's deadline has passed?",
    concept: "Safe retries",
    how: "Retries help with transient failures and hurt with everything else. Bound attempts, retry only retryable errors (timeouts, 5xx, 429), and back off exponentially with jitter so clients don't retry in lockstep. A retried non-idempotent request (POST) can apply twice unless it carries an idempotency key. Retry at one layer only: three layers of 3 attempts each make 27 calls per user request just when the dependency is weakest. Retries must respect the caller's deadline; one that can't finish in time is wasted load. Retry budgets (e.g. at most 10% extra requests) cap the damage.",
    rule: "Retry once, at one layer, with capped exponential backoff and jitter, only on retryable errors, only within the deadline, and only for idempotent or keyed requests.",
    why: (I) => I.lv === 1 ? "The loop never ends and retries every error, so a permanent 400 spins forever and every client keeps hammering the dependency at 10 rps each while it recovers." : I.lv === 2 ? "The POST has no idempotency key, so a retry after a timeout can double-create; Retry-After is seconds but sleep() takes milliseconds; and backoff without jitter keeps every client in sync." : "The handler is wrapped in withRetry, the reserve call has its own, and the gateway retries too: 3 × 3 × 3 = 27 calls per checkout. The pricing call retries a 2 s timeout three times inside a 2 s deadline, and retrying DEADLINE_EXCEEDED after the caller gave up is pure waste.",
  }));

  /* ================= classify ================= */
  const TZ_ITEMS = [
    ["When a card payment was captured", 0, 1], ["A dentist appointment at 09:00 in Berlin on 2027-04-12", 1, 1], ["A customer's date of birth", 2, 1],
    ["When a password-reset link expires (30 minutes after it's sent)", 0, 1], ["Each user's daily digest email at 07:00 in their own time zone", 1, 1],
    ["A public holiday (2026-12-25) used to skip deliveries", 2, 2], ["The timestamp on an audit-log entry", 0, 2], ["A hotel booking's check-in date", 2, 2],
    ["A weekly team meeting: Mondays 10:00 New York time, for the next year", 1, 2], ["A flight's scheduled departure, as printed on the ticket", 1, 3],
    ["A subscription's renewal moment, computed once at purchase as exactly 30 days later", 0, 3], ["The last-seen time of a user session", 0, 3]
  ];
  S.push({
    id: "data-time-storage",
    name: "Pick the right time type",
    kind: "Design review",
    skills: ["design"],
    w: "classify",
    gen(lv, R) { const pool = TZ_ITEMS.map((x, i) => i).filter((i) => TZ_ITEMS[i][2] <= lv); const fresh = pool.filter((i) => TZ_ITEMS[i][2] === lv); const n = lv === 1 ? 5 : lv === 2 ? 6 : 7; const pick = [...R.sample(fresh, Math.min(fresh.length, lv === 1 ? 5 : 3)), ...R.sample(pool.filter((i) => TZ_ITEMS[i][2] < lv), n)].slice(0, n); return { lv, items: R.shuffle(pick) }; },
    text: (I) => `<p>You're reviewing the schema for a new scheduling product used in 40 countries. For each field, choose how it should be stored.${I.lv === 3 ? " Think about what must still be right if a government changes its DST rules next year." : ""}</p><ul><li><b>UTC instant</b>: <code>timestamptz</code></li><li><b>Local time + IANA zone</b>: e.g. <code>(local timestamp, 'Europe/Berlin')</code>, resolved to an instant when needed</li><li><b>Calendar date</b>: <code>date</code>, no time or zone</li></ul>`,
    ui: (I) => ({ items: I.items.map((i) => TZ_ITEMS[i][0]), cats: ["UTC instant", "Local time + zone", "Calendar date"] }),
    ans: (I) => I.items.map((i) => TZ_ITEMS[i][1]),
    diag: (I, a) => { const k = a.findIndex((c, j) => c !== TZ_ITEMS[I.items[j]][1]); return `Look again at <b>${esc(TZ_ITEMS[I.items[k]][0])}</b>: is it a moment that already has (or will have) a fixed position on the timeline, a wall-clock time somewhere, or a day?`; },
    hint: (I) => "Ask: if the zone's DST rules changed tomorrow, should this value move with the local clock (local + zone), stay the same moment (UTC), or is it just a day (date)?",
    concept: "Instants, wall-clock times and dates",
    how: "There are three kinds of time. An instant is a point on the global timeline (when something happened, or a deadline computed as a duration); store it in UTC. A future civil time is defined by a local clock in a place (an appointment, a 07:00 alarm, a flight departure); store the local time and the IANA zone, and resolve it to an instant late, because offsets and DST rules can change before it happens. A date (birthday, holiday, check-in day) has no time zone at all; storing it as midnight UTC shifts it by a day for half the world.",
    rule: "Past events and durations: UTC. Future things people schedule by their clock: local time + IANA zone. Days: date.",
    why: (I) => I.items.map((i) => `${esc(TZ_ITEMS[i][0])} → <b>${["UTC instant", "local time + zone", "date"][TZ_ITEMS[i][1]]}</b>`).join("; ") + ".",
  });

  const JS_ITEMS = [
    ["Add an optional key \"theme\" (old code ignores unknown keys)", 0, 1],
    ["Rename key \"tz\" to \"timezone\"", 2, 1],
    ["Change \"limit\" from a number (10) to a string (\"10\")", 2, 1],
    ["Start writing a new value \"weekly\" for \"digest\" (old code throws on unknown enum values)", 1, 1],
    ["Stop writing optional key \"beta\" (old code treats it as optional)", 0, 2],
    ["Stop writing key \"locale\", which old code requires", 1, 2],
    ["Move \"email_opt_in\" under a nested \"notifications\" object", 2, 2],
    ["Add key \"quiet_hours\" that the new code requires to be present when reading", 2, 3],
    ["Start writing \"digest\": null (old code checks only whether the key exists)", 1, 3],
    ["Add an array element type {\"kind\":\"sms\"} to \"channels\" (old code switch()es on kind and throws by default)", 1, 3],
  ];
  S.push({
    id: "data-json-evolution",
    name: "Evolve a JSON column",
    kind: "Change plan",
    skills: ["safe", "design"],
    w: "classify",
    gen(lv, R) { const pool = JS_ITEMS.map((x, i) => i).filter((i) => JS_ITEMS[i][2] <= lv); const fresh = pool.filter((i) => JS_ITEMS[i][2] === lv); const n = lv === 1 ? 4 : lv === 2 ? 5 : 6; return { lv, items: R.shuffle([...fresh, ...R.sample(pool.filter((i) => JS_ITEMS[i][2] < lv), n - fresh.length)]) }; },
    text: (I) => `<p><code>accounts.prefs</code> is a JSONB document. Every change ships with a rolling deploy, so <b>old and new app versions read and write the same documents for a while</b>, and a rollback can bring the old version back${I.lv === 3 ? "; millions of existing documents are never rewritten unless you backfill them" : ""}. Classify each change:</p><ul><li><b>Safe in one deploy</b></li><li><b>Readers first</b>: ship tolerant readers everywhere, then start writing</li><li><b>Expand/contract</b>: needs dual shapes, a backfill or a multi-step migration</li></ul>`,
    ui: (I) => ({ items: I.items.map((i) => JS_ITEMS[i][0]), cats: ["Safe in one deploy", "Readers first", "Expand/contract"] }),
    ans: (I) => I.items.map((i) => JS_ITEMS[i][1]),
    diag: (I, a) => { const k = a.findIndex((c, j) => c !== JS_ITEMS[I.items[j]][1]); return `Reconsider <b>${esc(JS_ITEMS[I.items[k]][0])}</b>: what does an old version do with a document written by the new one, and what does the new version do with the documents already stored?`; },
    hint: () => "Check both directions: old code reading new documents, and new code reading old documents.",
    concept: "Schema evolution for schemaless columns",
    how: "A JSON column has a schema; it just lives in every version of the code that reads it. Changes are backward compatible (new code reads old data) and forward compatible (old code reads new data) in different ways. Adding an optional field that old readers ignore is safe. Writing a new enum value, or dropping a field old readers require, is safe only after every reader tolerates it, so readers ship first. Renames, type changes, restructuring, and new fields that new code requires on existing data need expand/contract: write both shapes, backfill, switch readers, then stop writing the old shape.",
    rule: "Read tolerantly (ignore unknown keys, default missing ones), add before you remove, and ship readers before writers.",
    why: (I) => I.items.map((i) => `${esc(JS_ITEMS[i][0])} → <b>${["safe", "readers first", "expand/contract"][JS_ITEMS[i][1]]}</b>`).join("; ") + ".",
  });

  const RT_ITEMS = [
    ["GET /v1/orders/9 → 503 Service Unavailable", 0, 1], ["POST /v1/payments → 400 invalid_currency", 2, 1], ["POST /v1/payments → read timeout after the request was sent", 1, 1],
    ["PUT /v1/users/7/avatar → 502 Bad Gateway", 0, 1], ["POST /v1/emails → 429 Too Many Requests, Retry-After: 30", 0, 2], ["POST /v1/orders → 504 Gateway Timeout from the load balancer", 1, 2],
    ["POST /v1/transfers → 422 \"idempotency key reused with a different body\"", 2, 2], ["POST /v1/payments → 500 Internal Server Error", 1, 2],
    ["POST /v1/payments → connection refused (TCP connect failed)", 0, 3], ["Our own transaction → Postgres 40001 serialization_failure", 0, 3], ["INSERT INTO users → Postgres 23505 unique_violation", 2, 3], ["DELETE /v1/sessions/abc → 404 Not Found on the retry", 2, 3],
  ];
  S.push({
    id: "data-retry-classify",
    name: "Which failures should we retry?",
    kind: "Design review",
    skills: ["design", "safe"],
    w: "classify",
    gen(lv, R) { const pool = RT_ITEMS.map((x, i) => i).filter((i) => RT_ITEMS[i][2] <= lv); const fresh = pool.filter((i) => RT_ITEMS[i][2] === lv); const n = lv === 1 ? 4 : lv === 2 ? 5 : 6; return { lv, items: R.shuffle([...fresh, ...R.sample(pool.filter((i) => RT_ITEMS[i][2] < lv), n - fresh.length)]) }; },
    text: (I) => `<p>You're writing the retry policy for the order service's outbound calls. For each failure, decide what the client should do:</p><ul><li><b>Retry with backoff</b> (as is)</li><li><b>Retry only with an idempotency key</b>: the server may already have done the work</li><li><b>Don't retry</b>: fix the request, treat as done, or surface the error</li></ul>`,
    ui: (I) => ({ items: I.items.map((i) => RT_ITEMS[i][0]), cats: ["Retry with backoff", "Only with idempotency key", "Don't retry"] }),
    ans: (I) => I.items.map((i) => RT_ITEMS[i][1]),
    diag: (I, a) => { const k = a.findIndex((c, j) => c !== RT_ITEMS[I.items[j]][1]); return `Reconsider <b>${esc(RT_ITEMS[I.items[k]][0])}</b>: could the server have done the work, and will repeating the same request ever succeed?`; },
    hint: () => "Two questions: did the request possibly take effect, and is the failure transient?",
    concept: "Retryability: transient vs permanent, and did it happen?",
    how: "A retry is safe when the operation is idempotent (GET, PUT, DELETE by definition; anything with an idempotency key) or when you know the server never processed the request (connection refused, 429 and 503 rejections). Timeouts, 500s and 502/504s on non-idempotent calls are ambiguous: the work may have happened, so only retry with a key. Client errors (400, 422, conflicts) won't change by repetition. A Postgres serialization failure (40001) means the whole transaction rolled back and should be retried; a unique violation (23505) is a real answer. A 404 on a retried DELETE usually means the first attempt worked.",
    rule: "Retry transient failures with backoff; retry ambiguous ones only with an idempotency key; never retry a request the server rejected as wrong.",
    why: (I) => I.items.map((i) => `${esc(RT_ITEMS[i][0])} → <b>${["retry with backoff", "only with an idempotency key", "don't retry"][RT_ITEMS[i][1]]}</b>`).join("; ") + ".",
  });

  /* ================= select: pagination simulation ================= */
  const hhmm = (s) => `10:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  function pageSim(I) {
    // posts: {id, t}, newest first by (t desc, id desc). Page size 4, three page loads.
    let posts = I.posts.slice();
    const sortP = () => posts.sort((a, b) => b.t - a.t || b.id - a.id);
    sortP();
    const pages = [], seen = [];
    let lastT = null;
    for (let p = 0; p < 3; p++) {
      if (p > 0) { (I.ev[p - 1] || []).forEach((e) => { if (e.add) posts.push(e.add); if (e.del) posts = posts.filter((x) => x.id !== e.del); }); sortP(); }
      let pg;
      if (I.lv < 3) pg = posts.slice(p * 4, p * 4 + 4);
      else pg = posts.filter((x) => lastT == null || x.t < lastT).slice(0, 4);
      if (pg.length) lastT = pg[pg.length - 1].t;
      pages.push(pg.map((x) => x.id)); pg.forEach((x) => seen.push(x.id));
    }
    return { pages, seen, posts };
  }
  S.push({
    id: "data-offset-pages",
    name: "Posts that vanish between pages",
    kind: "Investigation",
    skills: ["diagnose"],
    w: "select",
    gen(lv, R) {
      const base = R.int(100, 800);
      let t = 3000;
      const posts = [];
      for (let k = 0; k < 14; k++) { t -= lv === 3 ? (R.chance(0.45) ? 0 : R.int(5, 40)) : R.int(5, 40); posts.push({ id: base + 14 - k, t }); }
      const ev = [[], []];
      if (lv === 1) { const n = R.int(1, 3); for (let k = 0; k < n; k++) ev[0].push({ add: { id: base + 20 + k, t: 3000 + 10 * (k + 1) } }); if (R.chance(0.5)) ev[1].push({ add: { id: base + 30, t: 3100 } }); }
      if (lv === 2) { const top = posts.slice(0, 4); ev[0].push({ del: R.pick(top).id }); ev[1].push({ del: posts[R.int(4, 7)].id }); ev[0].push({ add: { id: base + 20, t: 3050 } }); }
      const I = { lv, posts, ev, base };
      const r = pageSim(I);
      const ans = lv === 1 ? [...new Set(r.seen.filter((id, i) => r.seen.indexOf(id) !== i))] : posts.slice(0, 12).map((x) => x.id).filter((id) => !r.seen.includes(id) && r.posts.some((x) => x.id === id));
      if (!ans.length) return null;
      if (lv === 3 && !r.pages.every((p) => p.length === 4)) return null;
      I.opts = [...new Set([...posts.slice(0, 12).map((x) => x.id), ...ev.flat().filter((e) => e.add).map((e) => e.add.id)])].sort((a, b) => b - a);
      return I;
    },
    text: (I) => {
      const evs = I.ev.map((es, k) => es.length ? `<li>Between page ${k + 1} and page ${k + 2}: ${es.map((e) => e.add ? `post #${e.add.id} published` : `post #${e.del} deleted by moderation`).join(", ")}</li>` : "").join("");
      const q = I.lv < 3 ? "SELECT id FROM posts ORDER BY created_at DESC LIMIT 4 OFFSET :page * 4" : "SELECT id FROM posts WHERE created_at < :last_created_at\nORDER BY created_at DESC LIMIT 4";
      const tl = K.table(["post", "created_at"], I.posts.slice(0, 12).map((x) => ["#" + x.id, hhmm(x.t)]), { compact: true });
      return `<p>The feed API pages with:</p>${K.pre(q)}<p>A user loads pages 1, 2 and 3. Posts at the start, newest first:</p>${tl}<ul>${evs || "<li>Nothing changes between page loads.</li>"}</ul><p><b>${I.lv === 1 ? "Which posts did the user see twice?" : "Which posts from the original top 12, still published, did the user never see?"}</b> Simulate it by hand.</p>`;
    },
    ui: (I) => ({ opts: I.opts.map((id) => "#" + id) }),
    ans: (I) => { const r = pageSim(I); const want = I.lv === 1 ? [...new Set(r.seen.filter((id, i) => r.seen.indexOf(id) !== i))] : I.posts.slice(0, 12).map((x) => x.id).filter((id) => !r.seen.includes(id) && r.posts.some((x) => x.id === id)); return want.map((id) => I.opts.indexOf(id)).sort((a, b) => a - b); },
    show: (I) => { const r = pageSim(I); return `Pages served: ${r.pages.map((p, k) => `page ${k + 1} = ${p.map((x) => "#" + x).join(", ")}`).join("; ")}.`; },
    hint: (I) => I.lv === 1 ? "OFFSET counts rows in the list as it is now, not as it was when page 1 loaded." : I.lv === 2 ? "A deletion above the cursor shifts everything up by one." : "What happens to the other posts that share the last post's created_at?",
    concept: "Offset vs keyset pagination",
    how: "OFFSET n counts rows in the current result, so inserts above the cursor push already-seen rows onto the next page (duplicates) and deletes pull unseen rows back onto a page the user has passed (skips). Deep offsets are also slow: the database still reads and discards n rows. Keyset (cursor) pagination remembers the last row's sort key and asks for rows after it, which is stable under inserts and deletes and uses an index. The key must be unique: with ties on created_at, <code>created_at &lt; :last</code> skips the tied rows, so page on <code>(created_at, id) &lt; (:last_created_at, :last_id)</code>.",
    rule: "Page feeds with an opaque cursor over a unique, indexed sort key such as (created_at, id), never with OFFSET.",
    why: (I) => { const r = pageSim(I); return `The pages actually served were ${r.pages.map((p, k) => `page ${k + 1}: ${p.map((x) => "#" + x).join(", ")}`).join("; ")}.`; },
  });

  /* ================= select: denormalisation with a cost model ================= */
  const DN = [
    { n: "Copy author name and avatar into every post row", save: 35, wr: (I) => I.edits * I.postsPer, why: "profile edits rewrite all of an author's posts" },
    { n: "Keep a comment_count column on posts, updated in the same transaction", save: 45, wr: (I) => I.comments, hot: (I) => I.hotComments },
    { n: "Keep a like_count column on posts, updated per like", save: 40, wr: (I) => I.likes, hot: (I) => I.hotLikes },
    { n: "Fan out on write: insert each new post into every follower's feed table", save: 110, wr: (I) => I.posts * I.followers },
    { n: "Store tag names as a JSON array on each post", save: 18, wr: (I) => I.tagRenames * 40000 },
    { n: "Add an index on posts (author_id, created_at DESC)", save: 30, wr: (I) => I.posts },
  ];
  function dnEval(I, a) {
    const p99 = I.base - a.reduce((s, i) => s + DN[i].save, 0);
    const wr = a.reduce((s, i) => s + DN[i].wr(I), 0);
    const hot = I.lv === 3 ? a.filter((i) => DN[i].hot && DN[i].hot(I) > I.rowCap) : [];
    return { p99, wr, hot };
  }
  S.push({
    id: "data-denormalise",
    name: "Speed up the feed, carefully",
    kind: "Design review",
    skills: ["design", "estimate"],
    w: "select",
    sense: "min",
    vname: "extra writes/s:",
    gen(lv, R) {
      const I = { lv, base: R.int(19, 23) * 10, edits: R.int(2, 6), postsPer: R.pick([300, 500, 800]), comments: R.int(40, 90), likes: R.int(600, 1500), posts: R.int(20, 40), followers: R.pick([800, 1500, 3000]), tagRenames: R.pick([0.01, 0.02]), hotLikes: R.int(250, 600), hotComments: R.int(10, 30), rowCap: 150, cap: lv === 1 ? 6000 : 3000 };
      I.target = lv === 1 ? I.base - 70 : lv === 2 ? I.base - 100 : I.base - 110;
      return I;
    },
    text: (I) => `<p>The home feed's p99 is <b>${I.base} ms</b>; the target is <b>${I.target} ms</b>. Each option below would cut read time by roughly the amount shown in the panel, at the cost of extra database writes. The primary can absorb <b>${K.num(I.cap)} extra row writes/s</b>.${I.lv === 3 ? ` A single row can take about ${I.rowCap} updates/s before lock waits pile up, and viral posts get ${I.hotLikes} likes/s.` : ""}</p><p><b>Meet the target with as few extra writes as possible.</b> Traffic: ${I.edits} profile edits/s (authors average ${I.postsPer} posts), ${I.comments} comments/s, ${K.num(I.likes)} likes/s, ${I.posts} new posts/s, ${I.followers} followers per author on average, ${I.tagRenames} tag renames/s (40k posts per tag).</p>`,
    ui: (I) => ({ opts: DN.map((d) => d.n), live: (a) => { const r = dnEval(I, a || []); return K.table(["option", "read saving", "extra writes/s"], DN.map((d, i) => [esc(d.n), "−" + d.save + " ms", K.num(d.wr(I), 1)]), { compact: true }) + K.metrics([{ name: "p99", value: r.p99 + " ms", ok: r.p99 <= I.target, target: `≤ ${I.target} ms` }, { name: "extra writes/s", value: K.num(r.wr, 1), ok: r.wr <= I.cap, target: `≤ ${K.num(I.cap)}` }, ...(I.lv === 3 ? [{ name: "hot-row updates", value: r.hot.length ? "over limit" : "ok", ok: !r.hot.length, target: `≤ ${I.rowCap}/s per row` }] : [])]); } }),
    valid: (I, a) => { const r = dnEval(I, a); if (r.p99 > I.target) return `p99 would be ${r.p99} ms, over ${I.target} ms`; if (r.wr > I.cap) return `${K.num(r.wr)} extra writes/s is more than the primary can take`; if (r.hot.length) return `${esc(DN[r.hot[0]].n)}: a viral post's row would get ${DN[r.hot[0]].hot(I)} updates/s and serialise on its row lock`; return true; },
    val: (I, a) => dnEval(I, a).wr,
    hint: (I) => I.lv === 1 ? "Compare saving per extra write." : I.lv === 2 ? "Fan-out on write is the biggest saving and the biggest bill." : "A counter column on a viral post becomes a single hot row.",
    concept: "Denormalisation is a write-side bill",
    how: "Denormalising copies or precomputes data so reads avoid joins and aggregates; every copy must then be updated whenever its source changes. The cost is write amplification (one profile edit rewriting hundreds of rows, one post fanning out to thousands of feeds), consistency windows while copies catch up, and hot rows when many writers update the same counter. Price each option as read time saved versus extra writes per second, and check the worst case (celebrity accounts, viral posts), not just the average. Cheaper tools such as the right index often get most of the gain.",
    rule: "Denormalise only where read savings clearly beat the extra writes, size it for the hottest key, and try an index first.",
    why: (I, sol) => { const r = dnEval(I, sol); return `The cheapest passing set is ${sol.map((i) => `<i>${esc(DN[i].n)}</i>`).join(", ")}: p99 ≈ ${r.p99} ms with ${K.num(r.wr, 1)} extra writes/s.`; },
  });

  /* ================= estimates ================= */
  S.push({
    id: "data-idem-storage",
    name: "Size the idempotency-key table",
    kind: "Estimate",
    skills: ["estimate"],
    w: "num",
    gen(lv, R) { return { lv, rps: R.pick([80, 120, 250, 400]), ttlH: lv === 3 ? 24 * 7 : 24, row: R.pick([900, 1200, 1500]), retry: R.pick([5, 8, 12]), copies: lv >= 2 ? 3 : 1, resp: R.pick([700, 900, 1100]) }; },
    truth: (I) => { const keys = I.rps * 3600 * I.ttlH; const row = I.lv === 3 ? I.row - I.resp + I.resp / 4 : I.row; return (keys * row * I.copies) / 1e9; },
    text: (I) => `<p>The payments API stores one row per idempotency key: the key, a request hash, the stored response and index entries come to about <b>${K.num(I.row)} bytes</b> per row${I.lv === 3 ? `, of which <b>${I.resp} bytes</b> is the response body. You plan to compress response bodies about 4:1` : ""}.</p><p>It accepts <b>${I.rps} new payments/s</b> on average; another ${I.retry}% of requests are retries that reuse an existing key. Keys are kept for <b>${I.ttlH === 24 ? "24 hours" : "7 days"}</b>${I.lv === 3 ? " (mobile clients queue retries while offline)" : ""}.${I.copies > 1 ? " The table lives on a primary with 2 replicas." : ""}</p><p><b>How many GB of disk does the table use${I.copies > 1 ? " across all three servers" : ""} in steady state?</b></p>`,
    ui: () => ({ unit: "GB" }),
    accept: (I, a) => LB.near((x) => S.find((p) => p.id === "data-idem-storage").truth(x), 0.25)(I, a),
    solve: (I) => Math.round(S.find((p) => p.id === "data-idem-storage").truth(I)),
    bad: (I) => { const t = S.find((p) => p.id === "data-idem-storage").truth(I); return [Math.round(t * 2.5), Math.round(t / 3) || 0.1]; },
    hint: (I) => "Rows alive at once = new keys per second × retention in seconds. Retries don't create keys.",
    concept: "Little's law for storage",
    how: "Anything with a retention period behaves like a queue: the number of items present equals the arrival rate times how long each stays (Little's law). Multiply by bytes per item and by the number of copies (replicas, backups) to get disk. Retries that reuse a key don't add rows. Compressing the largest field changes the per-row figure, not the count. A TTL also needs a deletion mechanism: partition by day and drop old partitions rather than DELETE-ing millions of rows.",
    rule: "Storage = rate × retention × bytes × copies; then plan how expired rows actually go away.",
    why: (I) => { const t = S.find((p) => p.id === "data-idem-storage").truth(I); return `${I.rps}/s × ${K.num(3600 * I.ttlH)} s = ${K.num(I.rps * 3600 * I.ttlH)} live keys × ${I.lv === 3 ? K.num(I.row - I.resp + I.resp / 4) : K.num(I.row)} B${I.copies > 1 ? " × 3 copies" : ""} ≈ <b>${K.num(t, 1)} GB</b>.`; },
  });

  S.push({
    id: "data-dedup-memory",
    name: "Memory for a dedup window",
    kind: "Estimate",
    skills: ["estimate", "design"],
    w: "num",
    gen(lv, R) { return { lv, rate: R.pick([2000, 5000, 12000, 20000]), win: lv === 1 ? R.pick([10, 15, 30]) : R.pick([60, 120]), per: R.pick([80, 96, 112]), fp: R.pick([0.01, 0.001]) }; },
    truth: (I) => { const n = I.rate * 60 * I.win; if (I.lv === 3) return (n * (-Math.log(I.fp) / Math.LN2 ** 2)) / 8 / 1e6; return (n * I.per * (I.lv === 2 ? 2 : 1)) / 1e6; },
    text: (I) => `<p>An event consumer receives <b>${K.num(I.rate)} messages/s</b> with at-least-once delivery; redeliveries arrive within <b>${I.win} minutes</b>. You'll remember every message id seen in that window ${I.lv === 3 ? `in a <b>Bloom filter</b> sized for a <b>${K.pct(I.fp)}</b> false-positive rate (a false positive drops a genuine message, which the business accepts at that rate)` : `in Redis, at about <b>${I.per} bytes</b> per id including key overhead and expiry metadata${I.lv === 2 ? ", on a primary plus one replica" : ""}`}.</p><p><b>How many MB of memory${I.lv === 2 ? " in total" : ""}?</b>${I.lv === 3 ? " (A Bloom filter needs −ln(p) / (ln 2)² bits per element.)" : ""}</p>`,
    ui: () => ({ unit: "MB" }),
    accept: (I, a) => LB.near((x) => S.find((p) => p.id === "data-dedup-memory").truth(x), 0.25)(I, a),
    solve: (I) => Math.round(S.find((p) => p.id === "data-dedup-memory").truth(I)),
    bad: (I) => { const t = S.find((p) => p.id === "data-dedup-memory").truth(I); return [Math.round(t * 8), Math.round(t / 4)]; },
    hint: (I) => I.lv === 3 ? "n = rate × window seconds; bits = n × (−ln p) / (ln 2)²; divide by 8 for bytes." : "Ids alive at once = rate × window in seconds.",
    concept: "Dedup windows: exact sets vs Bloom filters",
    how: "A dedup window must remember every id for as long as a duplicate can arrive, so memory = rate × window × bytes per id. Exact sets in Redis cost tens of bytes per small key once you include key and expiry overhead, and replication doubles it. A Bloom filter stores set membership in about 1.44 · log2(1/p) bits per element (9.6 bits at 1%, 14.4 at 0.1%), at the price of false positives, which here means dropping a real message. Rotating filters (one per time slice) give expiry. The window must cover the real redelivery horizon, including consumer outages, or duplicates slip through.",
    rule: "Size the window from the broker's real redelivery horizon, then choose exact sets when false drops are unacceptable and Bloom filters when memory dominates.",
    why: (I) => { const t = S.find((p) => p.id === "data-dedup-memory").truth(I); return `${K.num(I.rate)}/s × ${I.win * 60} s = ${K.num(I.rate * 60 * I.win)} ids → ≈ <b>${K.num(t, 1)} MB</b>.`; },
  });

  /* ================= choice: a decision with numbers ================= */
  const PG_OPTS = ["OFFSET/LIMIT with page numbers", "Keyset on created_at only", "Keyset on (sort key, id) with an opaque cursor", "Snapshot all matching ids into Redis per session and page through them"];
  S.push({
    id: "data-pagination-choice",
    name: "Pick the pagination strategy",
    kind: "Decision",
    skills: ["design"],
    w: "choice",
    gen(lv, R) { return { lv, n: lv === 2 ? R.int(2, 6) * 1000 : R.int(20, 90) * 1000000, rate: R.int(30, 200) }; },
    text: (I) => I.lv === 1 ? `<p>The activity feed (${K.num(I.n)} rows, ~${I.rate} new rows/s) uses <code>OFFSET</code>. Users report duplicate items while scrolling, and <code>OFFSET 200000</code> queries take 1.8 s. Rows can share the same <code>created_at</code>. What should infinite scroll use?</p>`
      : I.lv === 2 ? `<p>The internal admin table lists ${K.num(I.n)} tenant accounts sorted by name, changes a few times a day, and support staff ask to \"jump to page 37\" and see \"page 12 of 80\". The query takes 4 ms at any page. What's the right choice?</p>`
        : `<p>The chat API returns message history (${K.num(I.n)} rows) ordered by <code>sent_at</code>. Messages can be deleted; many share a <code>sent_at</code> millisecond (bulk imports). Mobile clients page backwards and forwards and resume after days offline. What should the API use?</p>`,
    ui: () => ({ opts: PG_OPTS }),
    ans: (I) => PG_OPTS[I.lv === 2 ? 0 : 2],
    diag: (I, a) => a === PG_OPTS[1] ? "created_at/sent_at isn't unique: rows sharing the boundary value are skipped." : a === PG_OPTS[3] ? "A per-session id snapshot costs memory per user, expires, and still breaks when clients resume days later." : a === PG_OPTS[0] && I.lv !== 2 ? "OFFSET shifts under inserts and deletes and gets slower the deeper you go." : I.lv === 2 ? "Keyset can't jump to page 37 or count pages, and at this size OFFSET costs nothing." : "Not quite.",
    hint: (I) => I.lv === 2 ? "Engineering effort should follow the actual numbers." : "The cursor's sort key must be unique and must survive deletes.",
    concept: "Choosing a pagination strategy",
    how: "Keyset pagination is the default for large or fast-changing lists: it's stable under inserts and deletes and costs the same at any depth, but it can't jump to an arbitrary page or count pages cheaply, and its key must be unique (add the id as a tie-breaker) and opaque to clients so you can change it. OFFSET is fine for small, slowly-changing lists where users need page numbers. Snapshotting result ids per session is a niche tool with real memory and expiry costs.",
    rule: "Default to keyset with an opaque (sort key, id) cursor; use OFFSET only when the list is small and humans need page numbers.",
    why: (I) => I.lv === 2 ? `With ${K.num(I.n)} rows and 4 ms queries, OFFSET's costs don't show up, and it gives staff the page numbers they need.` : "A cursor encoding (sort key, id) is unique, survives deletes, and lets clients resume and page both ways.",
  });

  LB.addAll("data", S);
})();
