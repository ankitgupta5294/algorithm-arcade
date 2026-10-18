/* Ladder: a ranked arena. Your rank is a top-tech job level (L3 to L8) with an estimated pay band.
   A match is a 3x3 board of problem "bombs" with burning fuses. A rival bot races you for the same
   tiles in real time. Beat the rival's pace on a bomb and the blast also clears easier bombs next to it.
   Rating moves like chess Elo against the rival's rating. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util, PB = D.pb;
  if (!PB) return;
  const esc = U.esc;

  /* ---------- the ladder ---------- */
  // Pay is a rough estimate of yearly total pay at top tech companies in India, in lakh rupees.
  const LEVELS = [
    { k: "L3", title: "Software Engineer I", min: 0, pay: [25, 35] },
    { k: "L4", title: "Software Engineer II", min: 1200, pay: [40, 60] },
    { k: "L5", title: "Senior Engineer", min: 1400, pay: [65, 95] },
    { k: "L6", title: "Staff Engineer", min: 1600, pay: [100, 150] },
    { k: "L7", title: "Senior Staff Engineer", min: 1800, pay: [160, 230] },
    { k: "L8", title: "Principal Engineer", min: 2000, pay: [250, 350] },
  ];
  const levelIdx = (r) => { let i = 0; LEVELS.forEach((l, j) => { if (r >= l.min) i = j; }); return i; };
  const money = (lakh) => (lakh >= 100 ? `₹${(lakh / 100).toFixed(lakh >= 1000 ? 0 : 1).replace(/\.0$/, "")}Cr` : `₹${Math.round(lakh)}L`);
  const payFor = (r) => {
    const i = levelIdx(r), L = LEVELS[i], top = LEVELS[i + 1] ? LEVELS[i + 1].min : L.min + 200;
    const f = Math.max(0, Math.min(1, (r - L.min) / (top - L.min)));
    return L.pay[0] + f * (L.pay[1] - L.pay[0]);
  };
  const midPay = (i) => (LEVELS[i].pay[0] + LEVELS[i].pay[1]) / 2;

  /* ---------- rivals ---------- */
  // speed: multiplier on the L5 base solve time (lower is faster). err: chance of a wrong submission.
  const RIVALS = [
    { name: "Rohan", lvl: 0, rating: 1100, speed: 1.6, err: 0.3, vibe: "Eager new grad. Fast talker, slow solver." },
    { name: "Priya", lvl: 1, rating: 1300, speed: 1.3, err: 0.22, vibe: "Steady and careful. Rarely wastes a move." },
    { name: "Marcus", lvl: 2, rating: 1500, speed: 1.0, err: 0.15, vibe: "Senior who has seen every LeetCode trick." },
    { name: "Wei", lvl: 3, rating: 1700, speed: 0.8, err: 0.1, vibe: "Staff engineer. Quiet. Terrifying on graphs." },
    { name: "Sofia", lvl: 4, rating: 1900, speed: 0.65, err: 0.07, vibe: "Senior Staff. Designs the systems you debug." },
    { name: "Arjun", lvl: 5, rating: 2100, speed: 0.5, err: 0.04, vibe: "Principal. Has never lost a whiteboard round." },
  ];
  const TAUNT = {
    start: ["Let's see what you've got.", "Try to keep up.", "I've done this board before. Twice.", "May the fastest O(n) win."],
    steal: ["Mine. You were too slow.", "Thanks for warming that one up.", "Defused. Next.", "That one was easy. For me."],
    lost: ["Hey, I was on that!", "Lucky.", "Fine. Plenty more bombs.", "Okay, that was quick."],
    chain: ["A chain? Show-off.", "Wait, how did you clear all that?", "Okay, that was impressive."],
    boom: ["Ouch. Watch your fuses.", "Tick tock.", "That's going to hurt your packet."],
    win: ["Good game. Same time tomorrow?", "Don't get comfortable.", "Enjoy it. I'll be back."],
    lose: ["Better luck next match.", "Come back when you're ready.", "That's why I'm on this level."],
  };
  const pickOne = (a) => a[Math.floor(Math.random() * a.length)];

  const CATS = PB.CATS.filter((c) => c.id !== "classic");
  const SHORT = { arrays: "Arrays", windows: "Windows", strings: "Strings", stacks: "Stacks", search: "Search", grids: "Grids", graphs: "Graphs", trees: "Trees", greedy: "Greedy", dp: "DP", math: "Math", backtrack: "Backtrack", games: "Sim" };
  const short = (cat) => SHORT[cat] || cat;
  const ABBR = { arrays: "Arr", windows: "Win", strings: "Str", stacks: "Stk", search: "Srch", grids: "Grid", graphs: "Grph", trees: "Tree", greedy: "Grdy", dp: "DP", math: "Math", backtrack: "BT", games: "Sim" };
  // Each rival is strong in two topics and weak in one, fixed by their name.
  function profile(rv) {
    if (rv.prof) return rv.prof;
    let h = 0; for (const ch of rv.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const ids = CATS.map((c) => c.id), pick = () => { const i = h % ids.length; h = (h * 1103515245 + 12345) >>> 0; return ids.splice(i, 1)[0]; };
    const strong = [pick(), pick()], weak = [pick()];
    if (rv.name === "Wei" && !strong.includes("graphs")) { strong[0] = "graphs"; if (weak[0] === "graphs") weak[0] = "strings"; }
    return (rv.prof = { strong, weak });
  }
  const catMult = (rv, cat) => { const p = profile(rv); return p.strong.includes(cat) ? 0.75 : p.weak.includes(cat) ? 1.35 : 1; };
  const BASE = [0, 50, 100, 170]; // L5 seconds per difficulty
  const PTS = [0, 100, 200, 350];
  const LVNAME = ["", "Easy", "Medium", "Hard"];
  const paceFor = (rv, t) => BASE[t.lv] * rv.speed * catMult(rv, t.p.cat);

  /* ---------- saved state ---------- */
  const fresh = () => ({ rating: 1050, peak: 1050, played: 0, wins: 0, losses: 0, lstreak: 0, wstreak: 0, cats: {}, last: [] });
  let S = Object.assign(fresh(), D.store.get("ladder", {}));
  const save = () => D.store.set("ladder", S);
  const nemesis = () => RIVALS[Math.min(RIVALS.length - 1, levelIdx(S.rating) + 1)];
  // Your pace on a topic, as the level whose speed matches it.
  function topicLevel(cat) {
    const c = S.cats[cat];
    if (!c || c.n < 2) return null;
    const ratio = c.sum / c.n; // your time / L5 base time
    let best = 0;
    RIVALS.forEach((r, i) => { if (Math.abs(Math.log(r.speed / ratio)) < Math.abs(Math.log(RIVALS[best].speed / ratio))) best = i; });
    return best;
  }

  /* ---------- screens ---------- */
  function mount(root, cfg) {
    let match = null;
    const stop = () => { if (match) match.stop(); match = null; };

    function hub(flash) {
      stop();
      const li = levelIdx(S.rating), L = LEVELS[li], next = LEVELS[li + 1];
      const pct = next ? Math.round(((S.rating - L.min) / (next.min - L.min)) * 100) : 100;
      const nm = nemesis();
      const pip = S.lstreak >= 3;
      const topics = CATS.map((c) => ({ c, l: topicLevel(c.id) })).filter((x) => x.l != null);
      root.innerHTML = `
        <div class="camp ld">
          <div class="camp-head">
            <button class="btn ghost back" type="button">← All games</button>
            <div class="camp-title"><div class="eyebrow">Ladder · ranked</div><h2>${L.k} · ${esc(L.title)}</h2></div>
            <div class="stats">
              <div class="stat"><span>Rating</span><b>${S.rating}</b></div>
              <div class="stat"><span>Record</span><b>${S.wins}<small>W</small> ${S.losses}<small>L</small></b></div>
            </div>
          </div>
          ${flash || ""}
          ${pip ? `<div class="ld-pip"><b>You're on a PIP.</b> ${S.lstreak} losses in a row. Win your next match to get off it, or keep sliding toward ${LEVELS[Math.max(0, li - 1)].k}.</div>` : ""}
          <section class="ld-you">
            <div class="ld-pay"><span class="muted small">Estimated pay at your level</span><b>${money(payFor(S.rating))}<small>/yr</small></b></div>
            <div class="ld-climb">
              <div class="xpbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
              <div class="muted small">${next ? `${next.min - S.rating} rating to <b>${next.k}</b> · ${money(next.pay[0])}–${money(next.pay[1])}` : "Top of the ladder"}</div>
            </div>
            <ol class="ld-ladder">${LEVELS.map((l, i) => `<li class="${i === li ? "on" : i < li ? "past" : ""}"><b>${l.k}</b><span>${esc(l.title)}</span><em>${money(l.pay[0])}–${money(l.pay[1])}</em></li>`).join("")}</ol>
          </section>
          <h3 class="ld-h">Pick your rival</h3>
          <div class="ld-rivals">${RIVALS.map((r, i) => {
            const p = profile(r), beat = (S.beat || {})[r.name] || 0;
            return `<button type="button" class="ld-rival${r === nm ? " nem" : ""}" data-r="${i}">
              <span class="ld-rv-top"><span class="ld-av" aria-hidden="true">${r.name[0]}</span><span><b>${esc(r.name)}</b> <span class="muted">${LEVELS[r.lvl].k} · ${r.rating}</span></span>${r === nm ? `<span class="ld-tag">Nemesis</span>` : beat ? `<span class="ld-tag good">Beaten ×${beat}</span>` : ""}</span>
              <span class="ld-vibe">${esc(r.vibe)}</span>
              <span class="small muted">Strong: ${p.strong.map(short).join(", ")} · Weak: ${p.weak.map(short).join(", ")}</span>
            </button>`;
          }).join("")}</div>
          <h3 class="ld-h">Your level by topic</h3>
          ${topics.length ? `<div class="ld-topics">${topics.map(({ c, l }) => `<span class="ld-topic lvc${l}"><b>${LEVELS[l].k}</b> ${esc(short(c.id))}</span>`).join("")}</div><p class="muted small">Based on how fast you solve each topic compared with each level's pace. Play more to fill this in.</p>` : `<p class="muted small">Play a few matches and this fills in: your pace on each topic, as a job level.</p>`}
          <details class="strategy"><summary class="btn ghost">How a match works</summary><div class="strategy-body">
            <p>Nine problem bombs, each with a burning fuse. Tap one to solve it. Easy is worth ${PTS[1]}, Medium ${PTS[2]}, Hard ${PTS[3]}.</p>
            <p>Your rival works the same board live. If they defuse the bomb you're on first, it's theirs.</p>
            <p><b>Chain reaction:</b> beat your rival's pace by 25% and the blast also clears the easier bombs next to it, for half their points.</p>
            <p>A wrong answer burns 15 seconds of that fuse. A fuse that runs out explodes and costs you a heart. Lose all 3 and you're out.</p>
            <p>Higher score wins. Beating a stronger rival moves your rating more.</p>
            <p class="muted small">Pay figures are rough estimates for top tech companies, for motivation only.</p>
          </div></details>
        </div>`;
      root.querySelector(".back").addEventListener("click", () => cfg.exit());
      root.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => play(RIVALS[+b.dataset.r])));
      window.scrollTo(0, 0);
    }

    function buildBoard() {
      const pool = PB.list.filter((p) => !p.world && p.w && PB.widgets[p.w]);
      const lvs = U.shuffle([1, 1, 1, 1, 2, 2, 2, 3, 3]);
      const used = new Set(), cats = new Map();
      return lvs.map((lv, i) => {
        let p = null;
        for (let t = 0; t < 60 && !p; t++) {
          const c = pool[Math.floor(Math.random() * pool.length)];
          if (used.has(c.id) || (cats.get(c.cat) || 0) >= 2) continue;
          p = c;
        }
        p = p || pool.find((c) => !used.has(c.id));
        used.add(p.id); cats.set(p.cat, (cats.get(p.cat) || 0) + 1);
        const fuse = [0, 240, 360, 480][lv] + Math.random() * 150;
        return { i, p, lv, pts: PTS[lv], fuse, left: fuse, state: "live", by: null, yourTime: null };
      });
    }

    function play(rv) {
      stop();
      const tiles = buildBoard();
      const M = { rv, tiles, you: 0, them: 0, hearts: 3, t: 0, on: null, onStart: 0, bot: null, over: false, log: [], chains: 0 };
      let last = performance.now(), timer = null, widget = null;
      root.innerHTML = `
        <div class="ld ld-match">
          <div class="ld-hud">
            <div class="ld-side you"><span class="muted small">You</span><b class="ld-score-you">0</b><span class="ld-hearts"></span></div>
            <div class="ld-mid"><span class="ld-clock">0:00</span><button class="btn ghost small ld-quit" type="button">Forfeit</button></div>
            <div class="ld-side them"><span class="muted small">${esc(rv.name)} · ${LEVELS[rv.lvl].k}</span><b class="ld-score-them">0</b><span class="ld-bot small"></span></div>
          </div>
          <div class="ld-say" aria-live="polite"><span class="ld-av" aria-hidden="true">${rv.name[0]}</span><span class="ld-say-t"></span></div>
          <div class="ld-board">${tiles.map((t) => `<button type="button" class="ld-tile d${t.lv}" data-i="${t.i}">
              <span class="ld-tl">${LVNAME[t.lv]} · ${t.pts}</span><span class="ld-tc" data-ab="${ABBR[t.p.cat] || ""}">${esc(short(t.p.cat))}</span>
              <span class="ld-fuse"><i></i></span><span class="ld-rp"><i></i></span><span class="ld-mark"></span></button>`).join("")}</div>
          <div class="ld-work" hidden>
            <div class="ld-work-head"><span class="ld-work-title"></span><button class="btn ghost small ld-leave" type="button">← Board</button></div>
            <div class="prompt ld-goal"></div>
            <div class="camp-stage ld-stage"></div>
            <div class="feedback ld-fb" role="status" hidden></div>
            <div class="actions"><button class="btn primary ld-check" type="button">Defuse (check answer)</button><button class="btn ghost ld-clear" type="button">Clear</button></div>
          </div>
          <div class="ld-end" hidden></div>
        </div>`;
      const $ = (s) => root.querySelector(s);
      const tileEls = [...root.querySelectorAll(".ld-tile")];
      const say = (txt) => { $(".ld-say-t").textContent = `${rv.name}: “${txt}”`; const el = $(".ld-say"); el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); };
      const fb = (html, kind) => { const el = $(".ld-fb"); el.hidden = !html; el.innerHTML = html ? `<p class="${kind || ""}">${html}</p>` : ""; };
      say(pickOne(TAUNT.start));

      function botPick() {
        const live = tiles.filter((t) => t.state === "live");
        if (!live.length) { M.bot = null; return; }
        const rate = (t) => t.pts / paceFor(rv, t);
        live.sort((a, b) => rate(b) - rate(a));
        // Sometimes the rival goes straight for the bomb you're working on.
        let t = live[0];
        if (M.on && M.on.state === "live" && live.indexOf(M.on) < 3 && Math.random() < 0.45) t = M.on;
        let need = paceFor(rv, t) * (0.75 + Math.random() * 0.55);
        while (Math.random() < rv.err) need += 20;
        M.bot = { t, need, done: 0 };
      }

      function claim(t, who, how) {
        t.state = who; t.by = how || null;
        if (who === "you") M.you += how === "chain" ? t.pts / 2 : t.pts; else if (who === "rival") M.them += t.pts;
        if (M.bot && M.bot.t === t) M.bot = null;
      }

      function closeWork() {
        M.on = null; widget = null;
        $(".ld-work").hidden = true;
        $(".ld-board").classList.remove("mini");
        $(".ld-stage").innerHTML = "";
      }

      function open(t) {
        if (M.over || t.state !== "live") return;
        let L = null;
        for (let k = 0; k < 6 && !L; k++) {
          try { L = PB.level(t.p, t.lv); } catch (e) {
            const pool = PB.list.filter((p) => !p.world && p.w && PB.widgets[p.w] && p.cat === t.p.cat && !tiles.some((x) => x.p === p));
            t.p = pool[Math.floor(Math.random() * pool.length)] || t.p;
          }
        }
        if (!L) return;
        M.on = t; M.onStart = M.t; M.wrong = 0;
        $(".ld-board").classList.add("mini");
        $(".ld-work").hidden = false;
        $(".ld-work-title").innerHTML = `<b>${LVNAME[t.lv]} · ${t.pts}</b> <span class="muted">${esc(t.p.name)} · ${esc(short(t.p.cat))}</span>`;
        $(".ld-goal").innerHTML = typeof t.p.text === "function" ? t.p.text(L.I) : t.p.text;
        fb("");
        const stage = $(".ld-stage");
        stage.innerHTML = "";
        const host = {
          say: (h) => fb(h),
          submit(a) {
            if (M.over || M.on !== t || t.state !== "live") return;
            const g = PB.grade(L, a);
            if (!g.ok) {
              t.left = Math.max(1, t.left - 15);
              fb(`${g.msg} <b>The fuse burned 15s.</b>`, "lose");
              return;
            }
            solved(t);
          },
        };
        widget = PB.widgets[t.p.w](stage, L.spec, () => fb(""), host);
        D.ladder._widget = widget;
        $(".ld-check").hidden = !!widget.selfSubmit;
        $(".ld-clear").hidden = !!widget.selfSubmit;
        root.querySelector(".ld-work").scrollIntoView({ block: "start", behavior: "smooth" });
      }

      function solved(t) {
        const took = M.t - M.onStart, pace = paceFor(rv, t);
        t.yourTime = took;
        const c = (S.cats[t.p.cat] = S.cats[t.p.cat] || { n: 0, sum: 0 });
        c.n++; c.sum += took / BASE[t.lv];
        claim(t, "you");
        let msg = `Defused in ${fmt(took)}. ${rv.name}'s pace: ${fmt(pace)}.`;
        if (took < pace * 0.75) {
          const r = Math.floor(t.i / 3), col = t.i % 3;
          const hit = tiles.filter((x) => x.state === "live" && x.lv < t.lv && Math.abs(Math.floor(x.i / 3) - r) + Math.abs((x.i % 3) - col) === 1);
          hit.forEach((x) => { claim(x, "you", "chain"); x.yourTime = 0; });
          if (hit.length) { M.chains += hit.length; msg += ` <b>Chain reaction! +${hit.reduce((s, x) => s + x.pts / 2, 0)}</b>`; say(pickOne(TAUNT.chain)); flashTiles(hit); }
          else say(pickOne(TAUNT.lost));
        } else if (M.bot && M.bot.t === t) say(pickOne(TAUNT.lost));
        M.log.push(msg);
        closeWork();
        toast(msg, "win");
        if (M.bot && M.bot.t.state !== "live") M.bot = null;
        draw();
      }

      function toast(html, kind) {
        const el = document.createElement("div");
        el.className = `ld-toast ${kind || ""}`;
        el.innerHTML = html;
        root.querySelector(".ld-match").appendChild(el);
        setTimeout(() => el.remove(), 3200);
      }
      function flashTiles(list) { list.forEach((x) => { const e = tileEls[x.i]; e.classList.add("blast"); setTimeout(() => e.classList.remove("blast"), 900); }); }

      function step(dt) {
        M.t += dt;
        for (const t of tiles) {
          if (t.state !== "live") continue;
          t.left -= dt;
          if (t.left <= 0) {
            t.state = "boom"; t.left = 0; M.hearts--;
            flashTiles([t]);
            say(pickOne(TAUNT.boom));
            if (M.bot && M.bot.t === t) M.bot = null;
            if (M.on === t) { closeWork(); toast("<b>Boom.</b> The fuse ran out on your bomb. −1 heart.", "lose"); }
            else toast(`<b>Boom.</b> ${t.lv === 1 ? "An" : "A"} ${LVNAME[t.lv]} bomb exploded. −1 heart.`, "lose");
          }
        }
        if (!M.bot) botPick();
        if (M.bot) {
          M.bot.done += dt;
          if (M.bot.done >= M.bot.need) {
            const t = M.bot.t, wasYours = M.on === t;
            t.botTime = M.bot.need;
            claim(t, "rival");
            if (wasYours) { closeWork(); toast(`<b>${esc(rv.name)} defused your bomb first.</b> It's theirs.`, "lose"); say(pickOne(TAUNT.steal)); }
            M.bot = null;
          }
        }
        if (M.hearts <= 0 || tiles.every((t) => t.state !== "live")) end(M.hearts <= 0 ? "ko" : "done");
      }

      function fmt(s) { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

      function draw() {
        $(".ld-score-you").textContent = M.you;
        $(".ld-score-them").textContent = M.them;
        $(".ld-hearts").innerHTML = [0, 1, 2].map((k) => `<i class="${k < M.hearts ? "on" : ""}" aria-hidden="true">♥</i>`).join("") + `<span class="sr-only">${M.hearts} hearts</span>`;
        $(".ld-clock").textContent = fmt(M.t);
        const b = M.bot;
        $(".ld-bot").textContent = b ? `${LVNAME[b.t.lv]} ${short(b.t.p.cat)} ${Math.min(99, Math.round((b.done / b.need) * 100))}%` : "thinking…";
        tiles.forEach((t, k) => {
          const e = tileEls[k];
          e.classList.toggle("you", t.state === "you");
          e.classList.toggle("rival", t.state === "rival");
          e.classList.toggle("boom", t.state === "boom");
          e.classList.toggle("cur", M.on === t);
          const tgt = b && b.t === t;
          e.classList.toggle("tgt", !!tgt);
          e.disabled = t.state !== "live" || M.over;
          const f = t.left / t.fuse;
          e.querySelector(".ld-fuse i").style.width = `${f * 100}%`;
          e.classList.toggle("hot", t.state === "live" && t.left < 45);
          e.querySelector(".ld-rp i").style.width = tgt ? `${Math.min(100, (b.done / b.need) * 100)}%` : "0";
          e.querySelector(".ld-mark").textContent = t.state === "you" ? (t.by === "chain" ? "Chain ✓" : "Yours ✓") : t.state === "rival" ? rv.name : t.state === "boom" ? "Boom" : t.left < 45 ? fmt(t.left) : "";
          e.setAttribute("aria-label", `${LVNAME[t.lv]} ${short(t.p.cat)} bomb, ${t.pts} points, ${t.state === "live" ? `fuse ${fmt(t.left)}${tgt ? `, ${rv.name} working on it` : ""}` : t.state}`);
        });
        const cur = M.on && b && b.t === M.on;
        root.querySelector(".ld-work").classList.toggle("race", !!cur);
        if (M.on) $(".ld-work-head .ld-work-title").dataset.race = cur ? `${rv.name} is on this one too · ${Math.round((b.done / b.need) * 100)}%` : "";
      }

      function tick() {
        const now = performance.now();
        let dt = (now - last) / 1000; last = now;
        if (document.hidden || M.over) return;
        dt = Math.min(dt, 1);
        step(dt);
        if (!M.over) draw();
      }

      function end(why) {
        if (M.over) return;
        M.over = true;
        clearInterval(timer);
        closeWork();
        draw();
        const res = why === "forfeit" || why === "ko" ? 0 : M.you > M.them ? 1 : M.you < M.them ? 0 : 0.5;
        const before = S.rating, li0 = levelIdx(before);
        const E = 1 / (1 + Math.pow(10, (rv.rating - before) / 400));
        const delta = Math.round(40 * (res - E));
        S.rating = Math.max(800, before + delta);
        S.peak = Math.max(S.peak, S.rating);
        S.played++;
        if (res === 1) { S.wins++; S.wstreak++; S.lstreak = 0; S.beat = S.beat || {}; S.beat[rv.name] = (S.beat[rv.name] || 0) + 1; }
        else if (res === 0) { S.losses++; S.lstreak++; S.wstreak = 0; }
        S.last = [{ rv: rv.name, you: M.you, them: M.them, res, delta, at: Date.now() }, ...(S.last || [])].slice(0, 10);
        save();
        const li1 = levelIdx(S.rating);
        say(pickOne(res === 1 ? TAUNT.win : TAUNT.lose));

        // Per-topic breakdown for the bombs you solved and the ones the rival took.
        const rows = tiles.map((t) => {
          const pace = paceFor(rv, t);
          if (t.state === "you" && t.by !== "chain") {
            const faster = t.yourTime <= pace;
            return `<tr><td>${esc(short(t.p.cat))} <span class="muted small">${LVNAME[t.lv]}</span></td><td>${fmt(t.yourTime)}</td><td>${fmt(pace)}</td><td class="${faster ? "good" : "bad"}">${faster ? "Faster" : `${Math.round((t.yourTime / pace - 1) * 100)}% slower`}</td></tr>`;
          }
          if (t.state === "you") return `<tr><td>${esc(short(t.p.cat))} <span class="muted small">${LVNAME[t.lv]}</span></td><td colspan="2" class="muted">chain</td><td class="good">Blast</td></tr>`;
          if (t.state === "rival") return `<tr><td>${esc(short(t.p.cat))} <span class="muted small">${LVNAME[t.lv]}</span></td><td>–</td><td>${fmt(t.botTime || pace)}</td><td class="bad">Taken</td></tr>`;
          if (t.state === "boom") return `<tr><td>${esc(short(t.p.cat))} <span class="muted small">${LVNAME[t.lv]}</span></td><td colspan="2">–</td><td class="bad">Exploded</td></tr>`;
          return `<tr><td>${esc(short(t.p.cat))} <span class="muted small">${LVNAME[t.lv]}</span></td><td colspan="2">–</td><td class="muted">Not played</td></tr>`;
        }).join("");
        // The topic where you were slowest against this rival, expressed as a pay gap.
        const slow = tiles.filter((t) => t.state === "you" && t.by !== "chain" && t.yourTime > paceFor(rv, t)).sort((a, b) => b.yourTime / paceFor(rv, b) - a.yourTime / paceFor(rv, a))[0];
        let gap = "";
        if (slow) {
          const tl = topicLevel(slow.p.cat);
          if (tl != null && tl < rv.lvl) gap = `<p class="ld-gap">On <b>${esc(short(slow.p.cat))}</b> you're at <b>${LEVELS[tl].k}</b> pace; ${esc(rv.name)} is ${LEVELS[rv.lvl].k}. That gap is worth about <b>${money(midPay(rv.lvl) - midPay(tl))}/yr</b>.</p>`;
        }
        const head = why === "ko" ? "Knocked out" : why === "forfeit" ? "Forfeited" : res === 1 ? "You win" : res === 0 ? "You lose" : "Draw";
        const el = $(".ld-end");
        el.hidden = false;
        el.innerHTML = `
          <div class="result-banner ${res === 1 ? "win" : "lose"}"><div><b>${head}</b> · ${M.you} to ${M.them}</div>
          <div class="ld-delta ${delta >= 0 ? "up" : "down"}">Rating ${before} → <b>${S.rating}</b> (${delta >= 0 ? "+" : ""}${delta})</div></div>
          ${li1 > li0 ? `<div class="ld-promo"><div class="eyebrow">Promoted</div><b>${LEVELS[li1].k} · ${esc(LEVELS[li1].title)}</b><span>${money(LEVELS[li1].pay[0])}–${money(LEVELS[li1].pay[1])} a year</span></div>` : ""}
          ${li1 < li0 ? `<div class="ld-pip"><b>Demoted to ${LEVELS[li1].k}.</b> Win it back.</div>` : ""}
          ${S.lstreak === 3 ? `<div class="ld-pip"><b>You've been put on a PIP.</b> Three losses in a row.</div>` : ""}
          ${M.chains ? `<p>Chain reactions cleared <b>${M.chains}</b> bomb${M.chains > 1 ? "s" : ""}.</p>` : ""}
          <table class="ld-table"><thead><tr><th>Bomb</th><th>You</th><th>${esc(rv.name)}</th><th></th></tr></thead><tbody>${rows}</tbody></table>
          ${gap}
          <div class="actions"><button class="btn primary again" type="button">Rematch ${esc(rv.name)}</button><button class="btn ghost hub" type="button">Ladder</button></div>`;
        el.querySelector(".again").addEventListener("click", () => play(rv));
        el.querySelector(".hub").addEventListener("click", () => hub());
        el.scrollIntoView({ block: "start", behavior: "smooth" });
      }

      tileEls.forEach((e) => e.addEventListener("click", () => { const t = tiles[+e.dataset.i]; if (M.on !== t) open(t); }));
      $(".ld-stage").addEventListener("pb-submit", () => $(".ld-check").click());
      $(".ld-leave").addEventListener("click", () => { closeWork(); draw(); });
      $(".ld-check").addEventListener("click", () => {
        if (!widget || !M.on) return;
        const a = widget.get();
        if (a == null) { fb("Finish your answer first."); return; }
        const t = M.on;
        const g = PB.grade(PB.level(t.p, t.lv), a);
        if (!g.ok) { t.left = Math.max(1, t.left - 15); fb(`${g.msg} <b>The fuse burned 15s.</b>`, "lose"); draw(); return; }
        solved(t);
      });
      $(".ld-clear").addEventListener("click", () => { if (widget) widget.clear(); fb(""); });
      $(".ld-quit").addEventListener("click", () => { if (M.over) return hub(); if (confirm("Forfeit this match? It counts as a loss.")) end("forfeit"); });
      timer = setInterval(tick, 200);
      draw();
      window.scrollTo(0, 0);
      match = { M, stop: () => { clearInterval(timer); M.over = true; } };
      D.ladder._match = match;
    }

    hub();
    return { destroy: stop };
  }

  D.ladder = { LEVELS, RIVALS, levelIdx, payFor, state: () => S, reset: () => { S = fresh(); save(); } };

  D.registerMode({
    id: "ladder",
    name: "Ladder",
    group: "Ranked",
    topic: "Ranked · rivals",
    blurb: "Race a rival on a board of ticking problem bombs. Climb from L3 to L8 and watch your estimated pay grow.",
    custom: true,
    noBadges: true,
    featured: true,
    levelsLabel: () => `${LEVELS[levelIdx(S.rating)].k} · ${S.rating}`,
    footer: () => `${money(payFor(S.rating))}/yr · next rival: ${nemesis().name}`,
    mount,
  });
})();
