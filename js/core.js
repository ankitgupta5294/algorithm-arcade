/* Algorithm Arcade: shared utilities, saved progress and the quiz engine. */
(function () {
  "use strict";
  const D = (window.DSA = window.DSA || {});

  /* ---------------- Utilities ---------------- */
  const U = (D.util = {
    rand: (n) => Math.floor(Math.random() * n),
    randInt: (a, b) => a + Math.floor(Math.random() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
    shuffle(a) {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    sample: (arr, k) => U.shuffle(arr.slice()).slice(0, k),
    uniq: (arr) => [...new Set(arr)],
    range: (n) => [...Array(n).keys()],
    eq: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
    fmt: (a) => "[" + a.join(", ") + "]",
    esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
    distinctInts(n, lo, hi) {
      const s = new Set();
      while (s.size < n) s.add(U.randInt(lo, hi));
      return [...s];
    },
    letters: "ABCDEFGHIJKLMNOP".split(""),
    trim: (s) => s.replace(/^\n+/, "").replace(/\s+$/, ""),
    ordinal: (n) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th"),
  });

  /* Build n unique string options containing the answer. Candidates are used in order, then fallback() fills the rest. */
  U.options = function (answer, candidates, fallback, n = 4) {
    const out = [String(answer)];
    const push = (c) => {
      if (c == null) return;
      c = String(c);
      if (!out.includes(c) && out.length < n) out.push(c);
    };
    candidates.forEach(push);
    let guard = 0;
    while (out.length < n && fallback && guard++ < 300) push(fallback());
    return U.shuffle(out);
  };

  /* Numeric options: a couple of "trap" values first, then near misses. */
  U.numOptions = function (ans, traps = [], n = 4) {
    const t = U.shuffle(U.uniq(traps.filter((x) => Number.isFinite(x) && x >= 0 && x !== ans))).slice(0, 2);
    const near = U.shuffle([ans + 1, ans - 1, ans + 2, ans - 2, ans + 3]).filter((x) => x >= 0);
    const spread = Math.max(3, Math.round(ans * 0.4));
    return U.options(ans, [...t, ...near], () => Math.max(0, ans + U.randInt(-spread, spread)), n);
  };

  /* Options for array answers: given traps first, then small perturbations. */
  U.listOptions = function (ans, traps = [], n = 4) {
    const perturb = () => {
      const a = ans.slice();
      const r = U.rand(a.length >= 3 ? 4 : 2);
      const i = U.rand(a.length);
      if (r === 0 && typeof a[i] === "number") a[i] += U.pick([-3, -2, -1, 1, 2, 3, 5]);
      else if (r === 1 && a.length >= 2) a.splice(i, 1);
      else if (r === 2) { const j = Math.min(i + 1, a.length - 1); [a[i], a[j]] = [a[j], a[i]]; }
      else if (r === 3) a.reverse();
      else if (typeof a[i] === "number") a[i] += U.randInt(1, 6);
      return U.fmt(a);
    };
    const tr = U.shuffle(traps.filter(Boolean).map((t) => U.fmt(t)));
    return U.options(U.fmt(ans), tr, perturb, n);
  };

  /* ---------------- Storage ---------------- */
  const store = (D.store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("dsa-arcade:" + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("dsa-arcade:" + k, JSON.stringify(v));
      } catch (e) {}
    },
  });

  D.LEVELS = [
    { n: 1, name: "Easy", blurb: "Core operations and single-step reasoning." },
    { n: 2, name: "Medium", blurb: "Classic algorithms traced a few steps deep." },
    { n: 3, name: "Hard", blurb: "Longer traces, trickier traps, interview-grade patterns." },
    { n: 4, name: "Expert", blurb: "Recurrences, advanced structures and competitive-programming ideas." },
  ];

  D.RANKS = [
    { xp: 0, name: "Novice" },
    { xp: 300, name: "Apprentice" },
    { xp: 900, name: "Practitioner" },
    { xp: 2000, name: "Specialist" },
    { xp: 4000, name: "Expert" },
    { xp: 7500, name: "Master" },
    { xp: 12000, name: "Grandmaster" },
  ];
  D.rankFor = function (xp) {
    let i = 0;
    while (i + 1 < D.RANKS.length && xp >= D.RANKS[i + 1].xp) i++;
    const cur = D.RANKS[i], next = D.RANKS[i + 1];
    return { name: cur.name, index: i, floor: cur.xp, next: next ? next.xp : null, nextName: next ? next.name : null };
  };

  /* ---------------- Progress ---------------- */
  const P = (D.progress = {
    data: store.get("progress", { xp: 0, answered: 0, correct: 0, rounds: 0, modes: {} }),
    save() { store.set("progress", this.data); },
    get(mode, lvl) {
      const m = (this.data.modes[mode] = this.data.modes[mode] || {});
      return (m[lvl] = m[lvl] || { played: 0, best: 0, bestAcc: 0, mastered: false });
    },
    record(mode, lvl, { score, correct, total }) {
      const s = this.get(mode, lvl);
      const acc = total ? correct / total : 0;
      const res = { newBest: score > s.best, firstMastery: false, xp: correct * lvl * 10 };
      s.played++;
      s.best = Math.max(s.best, score);
      s.bestAcc = Math.max(s.bestAcc, acc);
      if (acc >= 0.8 && !s.mastered) {
        s.mastered = true;
        res.firstMastery = true;
        res.xp += 50 * lvl;
      }
      this.data.xp += res.xp;
      this.data.answered += total;
      this.data.correct += correct;
      this.data.rounds++;
      this.save();
      return res;
    },
    masteredCount() {
      let c = 0;
      Object.values(this.data.modes).forEach((m) => Object.values(m).forEach((s) => s.mastered && c++));
      return c;
    },
  });

  /* Draw questions from a handwritten bank, preferring the chosen level and unseen items. */
  D.drawFromBank = function (bankId, bank, level, count) {
    const seen = new Set(store.get("seen:" + bankId, []));
    const byDist = (dist) => bank.map((q, idx) => ({ q, idx })).filter((x) => Math.abs(x.q.d - level) === dist);
    let pool = [];
    for (let dist = 0; dist <= 3 && pool.length < count; dist++) {
      const tier = byDist(dist);
      const fresh = U.shuffle(tier.filter((x) => !seen.has(x.idx)));
      const old = U.shuffle(tier.filter((x) => seen.has(x.idx)));
      // Only borrow from other levels if this level is genuinely exhausted.
      pool = pool.concat(fresh, old).slice(0, count);
      if (dist === 0 && tier.length >= count) break;
    }
    return U.shuffle(pool).map((x) => ({ ...x.q, bank: { id: bankId, idx: x.idx }, key: bankId + ":" + x.idx }));
  };
  D.markSeen = function (q) {
    if (!q.bank) return;
    const k = "seen:" + q.bank.id;
    const s = new Set(store.get(k, []));
    s.add(q.bank.idx);
    store.set(k, [...s]);
  };
  D.seenCount = (bankId) => store.get("seen:" + bankId, []).length;

  /* ---------------- Quiz engine ---------------- */
  const LETTER_KEYS = "123456789";

  D.runQuiz = function (root, cfg) {
    const mode = cfg.mode;
    const level = cfg.level;
    const levelName = D.LEVELS[level - 1].name;
    const qs = cfg.make(level, cfg.count);
    const timer = cfg.timer || 0;
    const st = { i: 0, score: 0, streak: 0, bestStreak: 0, correct: 0, answered: false, t: timer, missed: [], done: false, seq: [] };

    root.innerHTML = `
      <div class="game">
        <div class="game-top">
          <button class="btn ghost back" type="button">← All games</button>
          <div class="game-title">
            <h2>${U.esc(mode.name)}</h2>
            <span class="pill lvl-${level}">${levelName}</span>
          </div>
          <div class="stats">
            <div class="stat"><span>Question</span><b data-s="q"></b></div>
            <div class="stat"><span>Streak</span><b data-s="streak">0</b></div>
            <div class="stat"><span>Score</span><b data-s="score">0</b></div>
          </div>
        </div>
        <div class="progress-dots" aria-hidden="true">${qs.map(() => "<i></i>").join("")}</div>
        ${timer ? '<div class="timer" aria-hidden="true"><i></i></div>' : ""}
        <div class="stage"></div>
      </div>`;

    const $ = (s) => root.querySelector(s);
    const stage = $(".stage");
    const dots = [...root.querySelectorAll(".progress-dots i")];
    $(".back").addEventListener("click", () => cfg.exit());

    function renderStats() {
      $('[data-s="q"]').textContent = `${Math.min(st.i + 1, qs.length)}/${qs.length}`;
      $('[data-s="streak"]').textContent = st.streak;
      $('[data-s="score"]').textContent = st.score;
      if (timer) {
        const bar = $(".timer i");
        bar.style.transform = `scaleX(${Math.max(0, st.t / timer)})`;
        $(".timer").classList.toggle("low", st.t <= timer * 0.25);
      }
    }

    function show() {
      const q = qs[st.i];
      st.answered = false;
      st.t = timer;
      st.seq = [];
      dots.forEach((d, k) => d.classList.toggle("cur", k === st.i));
      const kindLabel = { choice: "Choose one", order: "Click in order", line: "Click the buggy line" }[q.kind];
      stage.innerHTML = `
        <div class="q">
          <div class="q-meta"><span class="tag">${U.esc(q.tag || mode.name)}</span><span class="kind">${kindLabel}</span></div>
          <div class="prompt">${q.prompt}</div>
          ${q.figure ? `<div class="figure">${q.figure}</div>` : ""}
          ${q.code && q.kind !== "line" ? `<pre class="snippet"><code>${U.esc(q.code)}</code></pre>` : ""}
          <div class="answer-area"></div>
          <div class="feedback" role="status" hidden></div>
          <div class="actions next-row" hidden><button class="btn primary next" type="button"></button></div>
        </div>`;
      const area = stage.querySelector(".answer-area");
      if (q.kind === "choice") renderChoice(q, area);
      else if (q.kind === "order") renderOrder(q, area);
      else if (q.kind === "line") renderLines(q, area);
      stage.querySelector(".next").addEventListener("click", next);
      renderStats();
      const first = area.querySelector("button:not(:disabled)");
      if (first && cfg.focusFirst !== false) first.focus({ preventScroll: true });
    }

    function renderChoice(q, area) {
      area.innerHTML = `<div class="opts ${q.options.length > 4 || q.wide ? "one-col" : ""} ${q.mono === false ? "" : "mono"}">${q.options
        .map((o, k) => `<button class="opt" type="button" data-k="${k}"><kbd>${LETTER_KEYS[k]}</kbd><span>${U.esc(o)}</span></button>`)
        .join("")}</div>`;
      area.querySelectorAll(".opt").forEach((b) => b.addEventListener("click", () => answer(q.options[+b.dataset.k])));
    }

    function renderOrder(q, area) {
      const need = q.length || q.items.length;
      area.innerHTML = `
        <div class="seq" aria-live="polite"></div>
        <div class="chips">${q.items.map((it) => `<button class="chip-btn" type="button" data-v="${U.esc(it)}">${U.esc(it)}</button>`).join("")}</div>
        <div class="actions">
          <button class="btn ghost undo" type="button">Undo</button>
          <button class="btn ghost clear" type="button">Clear</button>
          <button class="btn primary submit" type="button" disabled>Check order</button>
        </div>`;
      const add = (v) => {
        if (st.answered || st.seq.length >= need) return;
        if (!q.repeat && st.seq.includes(v)) return;
        st.seq.push(v);
        syncOrder(q);
      };
      area.querySelectorAll(".chip-btn").forEach((b) => b.addEventListener("click", () => add(b.dataset.v)));
      stage.querySelectorAll(".figure [data-pick]").forEach((g) => {
        g.setAttribute("tabindex", "0");
        g.setAttribute("role", "button");
        g.addEventListener("click", () => add(g.dataset.pick));
        g.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            add(g.dataset.pick);
          }
        });
      });
      area.querySelector(".undo").addEventListener("click", () => { if (!st.answered) { st.seq.pop(); syncOrder(q); } });
      area.querySelector(".clear").addEventListener("click", () => { if (!st.answered) { st.seq = []; syncOrder(q); } });
      area.querySelector(".submit").addEventListener("click", () => answer(st.seq.slice()));
      syncOrder(q);
    }

    function syncOrder(q) {
      const need = q.length || q.items.length;
      const seqEl = stage.querySelector(".seq");
      const slots = [];
      for (let k = 0; k < need; k++) slots.push(`<span class="slot ${st.seq[k] != null ? "filled" : ""}">${st.seq[k] != null ? U.esc(st.seq[k]) : ""}</span>`);
      seqEl.innerHTML = slots.join('<span class="arrow">→</span>');
      stage.querySelectorAll(".chip-btn").forEach((b) => {
        b.disabled = st.answered || (!q.repeat && st.seq.includes(b.dataset.v)) || st.seq.length >= need;
      });
      stage.querySelectorAll(".figure [data-pick]").forEach((g) => {
        const pos = st.seq.indexOf(g.dataset.pick);
        g.classList.toggle("picked", pos >= 0);
        const ord = g.querySelector(".ord");
        if (ord) ord.textContent = pos >= 0 ? pos + 1 : "";
      });
      const sub = stage.querySelector(".submit");
      if (sub) sub.disabled = st.answered || st.seq.length !== need;
    }

    function renderLines(q, area) {
      area.innerHTML = `<div class="code-lines">${q.lines
        .map((l, k) => `<button class="line" type="button" data-k="${k}"><span class="ln">${k + 1}</span><code>${U.esc(l) || " "}</code></button>`)
        .join("")}</div>`;
      area.querySelectorAll(".line").forEach((b) => b.addEventListener("click", () => answer(+b.dataset.k)));
    }

    function isCorrect(q, given) {
      if (given == null) return false;
      if (q.kind === "choice") return given === q.answer;
      if (q.kind === "line") return given === q.answer || (q.accept || []).includes(given);
      if (q.kind === "order") return q.check ? q.check(given) : U.eq(given, q.answer);
      return false;
    }

    function answer(given) {
      if (st.answered || st.done) return;
      const q = qs[st.i];
      st.answered = true;
      D.markSeen(q);
      const ok = isCorrect(q, given);
      let head;
      if (ok) {
        st.streak++;
        st.bestStreak = Math.max(st.bestStreak, st.streak);
        st.correct++;
        const streakBonus = Math.min(st.streak - 1, 5) * 10;
        const timeBonus = timer ? Math.round((st.t / timer) * 100) : 0;
        const pts = (100 + streakBonus + timeBonus) * level;
        st.score += pts;
        head = `<strong class="win">Correct · +${pts}</strong>`;
        dots[st.i].classList.add("ok");
      } else {
        st.streak = 0;
        st.missed.push(q);
        head = `<strong class="lose">${given == null ? "Time's up." : "Not quite."}</strong>`;
        dots[st.i].classList.add("bad");
      }

      if (q.kind === "choice") {
        stage.querySelectorAll(".opt").forEach((b) => {
          const v = q.options[+b.dataset.k];
          b.disabled = true;
          if (v === q.answer) b.classList.add("right");
          else if (v === given) b.classList.add("wrong");
        });
      } else if (q.kind === "line") {
        stage.querySelectorAll(".line").forEach((b) => {
          const k = +b.dataset.k;
          b.disabled = true;
          if (k === q.answer || (q.accept || []).includes(k)) b.classList.add("right");
          else if (k === given) b.classList.add("wrong");
        });
      } else if (q.kind === "order") {
        syncOrder(q);
        stage.querySelector(".seq").classList.add(ok ? "right" : "wrong");
        stage.querySelectorAll(".undo,.clear").forEach((b) => (b.disabled = true));
      }

      let answerLine = "";
      if (!ok) {
        if (q.kind === "choice") answerLine = ` Answer: <span class="mono">${U.esc(q.answer)}</span>.`;
        if (q.kind === "order") answerLine = ` ${q.check ? "One valid order" : "Correct order"}: <span class="mono">${U.esc(q.answer.join(" → "))}</span>.`;
        if (q.kind === "line") answerLine = ` The bug is on line ${q.answer + 1}.`;
      }
      const fb = stage.querySelector(".feedback");
      fb.innerHTML = `<p>${head}${answerLine}</p><div class="explain">${q.explain || ""}</div>`;
      fb.hidden = false;
      const nx = stage.querySelector(".next");
      nx.textContent = st.i === qs.length - 1 ? "See results" : "Next question";
      stage.querySelector(".next-row").hidden = false;
      nx.focus({ preventScroll: true });
      fb.scrollIntoView({ block: "nearest", behavior: "smooth" });
      renderStats();
    }

    function next() {
      if (!st.answered) return;
      st.i++;
      if (st.i >= qs.length) return finish();
      show();
      root.querySelector(".game").scrollIntoView({ block: "start", behavior: "smooth" });
    }

    function finish() {
      st.done = true;
      const total = qs.length;
      const res = D.progress.record(mode.id, level, { score: st.score, correct: st.correct, total });
      const acc = Math.round((st.correct / total) * 100);
      dots.forEach((d) => d.classList.remove("cur"));
      if (timer) $(".timer").hidden = true;
      const verdict = acc === 100 ? "Flawless." : acc >= 80 ? "Level mastered." : acc >= 50 ? "Solid. Review the misses below." : "Keep going. The explanations below are the fastest way up.";
      stage.innerHTML = `
        <div class="results">
          <div class="eyebrow">Round complete · ${levelName}</div>
          <div class="result-row">
            <div><div class="big">${st.score}</div><div class="cap">points${res.newBest ? " · new best" : ""}</div></div>
            <div><div class="big">${st.correct}/${total}</div><div class="cap">${acc}% correct</div></div>
            <div><div class="big">+${res.xp}</div><div class="cap">XP${res.firstMastery ? " · mastery bonus" : ""}</div></div>
            <div><div class="big">${st.bestStreak}</div><div class="cap">best streak</div></div>
          </div>
          <p class="verdict">${verdict}${res.firstMastery ? ` You earned the <b>${levelName}</b> badge for ${U.esc(mode.name)}.` : ""}</p>
          <div class="actions">
            <button class="btn primary again" type="button">Play again</button>
            ${level < 4 ? `<button class="btn harder" type="button">Try ${D.LEVELS[level].name}</button>` : ""}
            <button class="btn ghost home" type="button">All games</button>
          </div>
          ${st.missed.length ? `<h3>Review your misses</h3><ol class="review">${st.missed.map(reviewItem).join("")}</ol>` : ""}
        </div>`;
      stage.querySelector(".again").addEventListener("click", () => cfg.restart(level));
      const h = stage.querySelector(".harder");
      if (h) h.addEventListener("click", () => cfg.restart(level + 1));
      stage.querySelector(".home").addEventListener("click", () => cfg.exit());
      stage.querySelector(".again").focus({ preventScroll: true });
      renderStats();
    }

    function reviewItem(q) {
      let ans = "";
      if (q.kind === "choice") ans = q.answer;
      if (q.kind === "order") ans = q.answer.join(" → ");
      if (q.kind === "line") ans = "Line " + (q.answer + 1) + ": " + q.lines[q.answer].trim();
      const code = q.code && q.kind !== "line" ? `<pre class="snippet small"><code>${U.esc(q.code)}</code></pre>` : "";
      return `<li><div class="rv-prompt">${q.review || q.prompt}</div>${code}<div class="rv-ans">Answer: <span class="mono">${U.esc(ans)}</span></div><div class="rv-why">${q.explain || ""}</div></li>`;
    }

    // Timer: runs only while this round is on screen and the tab is visible.
    let last = performance.now();
    const iv = setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      if (!timer || st.answered || st.done || document.hidden) return;
      st.t -= dt;
      if (st.t <= 0) {
        st.t = 0;
        answer(null);
      }
      renderStats();
    }, 100);

    function onKey(e) {
      if (st.done || e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      const q = qs[st.i];
      if (!st.answered && q.kind === "choice" && LETTER_KEYS.includes(e.key) && e.key !== "0") {
        const o = q.options[LETTER_KEYS.indexOf(e.key)];
        if (o != null) answer(o);
      } else if (!st.answered && q.kind === "order" && e.key === "Backspace") {
        e.preventDefault();
        st.seq.pop();
        syncOrder(q);
      } else if (st.answered && e.key === "Enter" && !(e.target.classList && e.target.classList.contains("next"))) {
        e.preventDefault();
        next();
      }
    }
    document.addEventListener("keydown", onKey);

    show();
    return {
      destroy() {
        clearInterval(iv);
        document.removeEventListener("keydown", onKey);
      },
    };
  };

  /* Mix generated questions so that every type appears before any repeats. */
  D.mixFrom = function (types, count) {
    const out = [];
    let bag = [];
    while (out.length < count) {
      if (!bag.length) bag = U.shuffle(types.slice());
      out.push(bag.pop()());
    }
    return out;
  };

  /* ---------------- Mode registry ---------------- */
  D.modes = [];
  D.registerMode = (m) => D.modes.push(m);
})();
