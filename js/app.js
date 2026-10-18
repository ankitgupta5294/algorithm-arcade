/* Algorithm Arcade: home screen, Gauntlet mode and navigation. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util;

  /* ---------- Gauntlet: a mixed round drawn from every quiz mode ---------- */
  D.registerMode({
    id: "gauntlet",
    name: "The Gauntlet",
    group: "Challenge",
    topic: "Everything",
    blurb: "15 mixed questions from every drill and simulator, against the clock.",
    generated: true,
    count: 15,
    timer: (lvl) => [40, 40, 45, 50][lvl - 1],
    make(lvl, count) {
      const sources = D.modes.filter((m) => m.make && m.id !== "gauntlet");
      const out = [], keys = new Set();
      let bag = [];
      while (out.length < count) {
        if (!bag.length) bag = U.shuffle(sources.slice());
        const m = bag.pop();
        for (let t = 0; t < 4; t++) {
          const q = m.make(lvl, 1)[0];
          if (q && (!q.key || !keys.has(q.key))) { if (q.key) keys.add(q.key); q.tag = `${m.name} · ${q.tag || m.topic}`; out.push(q); break; }
        }
      }
      return out;
    },
  });

  const GROUPS = [
    { id: "Ranked", note: "Race rivals for promotion. Your rank is a job level and an estimated pay band." },
    { id: "Engineering", note: "Real-world systems scenarios: debug, tune, design and ship against simulators." },
    { id: "Drills", note: "Hand-written problems, rotated so you see new ones first." },
    { id: "Simulators", note: "Generated fresh every round, so they never run out." },
    { id: "Puzzles", note: "Hands-on games where you are the algorithm." },
    { id: "Challenge", note: "Everything at once." },
  ];

  const root = document.getElementById("app");
  let level = D.store.get("level", 1);
  if (![1, 2, 3, 4].includes(level)) level = 1;
  let current = null;

  function bankLine(m) {
    if (m.bankSize) return `${m.bankSize} problems · ${Math.min(D.seenCount(m.id), m.bankSize)} seen`;
    if (m.custom) return `${m.rounds} puzzles per round`;
    return "Endless · generated";
  }

  function home(focusId) {
    if (current) { current.destroy(); current = null; }
    const P = D.progress.data;
    const rank = D.rankFor(P.xp);
    const pct = rank.next ? Math.round(((P.xp - rank.floor) / (rank.next - rank.floor)) * 100) : 100;
    const badges = D.progress.masteredCount(), totalBadges = D.modes.filter((m) => !m.noBadges).length * 4;
    const acc = P.answered ? Math.round((P.correct / P.answered) * 100) : 0;
    const handwritten = D.modes.reduce((s, m) => s + (m.bankSize || 0), 0);

    root.innerHTML = `
      <header class="hero">
        <div class="eyebrow">Data structures &amp; algorithms · ${D.modes.length} games · 4 levels</div>
        <h1>Algorithm Arcade<span class="o" aria-hidden="true"> O(1)</span></h1>
        <p class="lede">${D.lab && D.lab.list.length ? `<b>Systems Lab: ${D.lab.list.length.toLocaleString()} real-world engineering scenarios</b>, ` : ""}${D.pb ? `<b>${D.pb.list.length.toLocaleString()} hands-on problems</b> with three levels each, ` : ""}${handwritten} hand-written problems, and generators that build fresh stacks, heaps, trees, graphs and DP tables every round. Pick a level and play.</p>
      </header>

      <section class="profile" aria-label="Your progress on this device">
        <div class="rank">
          <div class="rank-name"><span class="muted">Rank</span> ${rank.name}</div>
          <div class="xpbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
          <div class="muted small">${P.xp} XP${rank.next ? ` · ${rank.next - P.xp} to ${rank.nextName}` : " · top rank"}</div>
        </div>
        <div class="pstat"><b>${badges}<small>/${totalBadges}</small></b><span>badges</span></div>
        <div class="pstat"><b>${P.rounds}</b><span>rounds</span></div>
        <div class="pstat"><b>${P.answered ? acc + "%" : "–"}</b><span>accuracy</span></div>
      </section>

      <section class="levels" aria-label="Difficulty">
        <div class="seg" role="radiogroup" aria-label="Difficulty level">
          ${D.LEVELS.map((l) => `<button type="button" role="radio" class="seg-btn lvl-${l.n}" data-level="${l.n}" aria-checked="${l.n === level}" tabindex="${l.n === level ? 0 : -1}">${l.name}</button>`).join("")}
        </div>
        <p class="level-blurb">${D.LEVELS[level - 1].blurb}</p>
      </section>

      ${GROUPS.map((g) => {
        const ms = D.modes.filter((m) => m.group === g.id).sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
        if (!ms.length) return "";
        return `<section class="group">
          <div class="group-head"><h2>${g.id}</h2><span class="muted">${g.note}</span></div>
          <div class="cards">${ms.map(card).join("")}</div>
        </section>`;
      }).join("")}

      <details class="cheats">
        <summary>Complexity cheat sheet</summary>
        ${cheatSheet()}
      </details>
      <p class="foot muted small">Progress is saved in this browser only. <button type="button" class="linklike reset-progress">Reset progress</button><span class="confirm-reset" hidden> Erase everything? <button type="button" class="linklike yes">Yes, reset</button> · <button type="button" class="linklike no">Cancel</button></span></p>`;

    root.querySelectorAll(".seg-btn").forEach((b, i, all) => {
      b.addEventListener("click", () => setLevel(+b.dataset.level));
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const n = all[(i + (e.key === "ArrowRight" ? 1 : 3)) % 4];
        setLevel(+n.dataset.level, true);
      });
    });
    root.querySelectorAll(".mode-card").forEach((c) => c.addEventListener("click", () => open(c.dataset.mode, level)));
    const rp = root.querySelector(".reset-progress"), cf = root.querySelector(".confirm-reset");
    rp.addEventListener("click", () => { cf.hidden = false; rp.hidden = true; });
    cf.querySelector(".no").addEventListener("click", () => { cf.hidden = true; rp.hidden = false; });
    cf.querySelector(".yes").addEventListener("click", () => {
      D.progress.data = { xp: 0, answered: 0, correct: 0, rounds: 0, modes: {} };
      D.progress.save();
      D.modes.forEach((m) => D.store.set("seen:" + m.id, []));
      home();
    });
    if (focusId) {
      const el = root.querySelector(`[data-mode="${focusId}"]`);
      if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "center" }); }
    } else window.scrollTo(0, 0);
  }

  function card(m) {
    const s = D.progress.get(m.id, level);
    if (m.noBadges) {
      return `<button type="button" class="mode-card${m.featured ? " featured" : ""}" data-mode="${m.id}">
      <span class="mc-top"><span class="mc-topic">${U.esc(m.topic)}</span><span class="mc-topic">★ ${m.levelsLabel ? m.levelsLabel() : D.pb ? (D.pb.list.length * 3).toLocaleString() + " levels" : ""}</span></span>
      <span class="mc-name">${U.esc(m.name)}</span>
      <span class="mc-blurb">${U.esc(m.blurb)}</span>
      <span class="mc-foot"><span>${m.footer ? m.footer() : ""}</span><span>Open</span></span>
    </button>`;
    }
    const pips = [1, 2, 3, 4].map((l) => `<i class="pip lvl-${l} ${D.progress.get(m.id, l).mastered ? "on" : ""}" title="${D.LEVELS[l - 1].name}${D.progress.get(m.id, l).mastered ? " mastered" : ""}"></i>`).join("");
    return `<button type="button" class="mode-card" data-mode="${m.id}">
      <span class="mc-top"><span class="mc-topic">${U.esc(m.topic)}</span><span class="pips" aria-label="Badges">${pips}</span></span>
      <span class="mc-name">${U.esc(m.name)}</span>
      <span class="mc-blurb">${U.esc(m.blurb)}</span>
      <span class="mc-foot"><span>${bankLine(m)}</span><span>${s.played ? `Best ${s.best}` : "Not played"}</span></span>
    </button>`;
  }

  function setLevel(l, focus) {
    level = l;
    D.store.set("level", l);
    const y = window.scrollY;
    home();
    window.scrollTo(0, y);
    if (focus) root.querySelector(`.seg-btn[data-level="${l}"]`).focus({ preventScroll: true });
  }

  function open(id, lvl, extra = {}) {
    const m = D.modes.find((x) => x.id === id);
    if (!m) return home();
    if (current) current.destroy();
    level = lvl;
    D.store.set("level", lvl);
    root.innerHTML = '<div class="mount"></div>';
    const mount = root.querySelector(".mount");
    const cfg = {
      ...extra,
      mode: m, level: lvl,
      exit: () => home(id),
      restart: (l) => open(id, l),
    };
    if (m.custom) current = m.mount(mount, cfg);
    else current = D.runQuiz(mount, { ...cfg, count: m.count, timer: m.timer ? m.timer(lvl) : 0, make: m.make });
    window.scrollTo(0, 0);
  }

  function cheatSheet() {
    const ds = [
      ["Array", "O(1)", "O(n)", "O(n)", "O(n)", "Append is amortised O(1)"],
      ["Sorted array", "O(1)", "O(log n)", "O(n)", "O(n)", "Binary search"],
      ["Linked list", "O(n)", "O(n)", "O(1)", "O(1)", "Given a pointer to the node"],
      ["Stack / queue", "–", "–", "O(1)", "O(1)", "Push/pop, enqueue/dequeue"],
      ["Hash table", "–", "O(1)", "O(1)", "O(1)", "Average. O(n) worst"],
      ["Balanced BST", "O(log n)", "O(log n)", "O(log n)", "O(log n)", "AVL, red-black"],
      ["Binary heap", "O(1) min", "O(n)", "O(log n)", "O(log n)", "heapify O(n)"],
      ["Trie", "–", "O(L)", "O(L)", "O(L)", "L = key length"],
      ["Union-Find", "–", "α(n)", "α(n)", "–", "Path compression + rank"],
      ["Segment / Fenwick", "O(log n)", "O(log n)", "O(log n)", "–", "Range query + point update"],
    ];
    const sorts = [
      ["Bubble", "n", "n²", "n²", "1", "yes"],
      ["Selection", "n²", "n²", "n²", "1", "no"],
      ["Insertion", "n", "n²", "n²", "1", "yes"],
      ["Merge", "n log n", "n log n", "n log n", "n", "yes"],
      ["Quick", "n log n", "n log n", "n²", "log n", "no"],
      ["Heap", "n log n", "n log n", "n log n", "1", "no"],
      ["Counting", "n + k", "n + k", "n + k", "k", "yes"],
      ["Radix (LSD)", "d(n + b)", "d(n + b)", "d(n + b)", "n + b", "yes"],
      ["Timsort", "n", "n log n", "n log n", "n", "yes"],
    ];
    const graphs = [
      ["BFS / DFS", "O(V + E)"], ["Topological sort", "O(V + E)"], ["Dijkstra (binary heap)", "O((V + E) log V)"],
      ["Bellman–Ford", "O(V · E)"], ["Floyd–Warshall", "O(V³)"], ["Kruskal", "O(E log E)"], ["Prim (binary heap)", "O(E log V)"], ["Tarjan SCC", "O(V + E)"],
    ];
    const t = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="mono"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    return `<div class="cheat-grid">
      <div><h3>Data structures</h3>${t(["", "Access", "Search", "Insert", "Delete", "Note"], ds)}</div>
      <div><h3>Sorting (time is O(·))</h3>${t(["", "Best", "Average", "Worst", "Space", "Stable"], sorts)}</div>
      <div><h3>Graphs</h3>${t(["Algorithm", "Time"], graphs)}</div>
    </div>`;
  }

  const fromHash = location.hash.slice(1);
  if (D.modes.some((m) => m.id === fromHash)) open(fromHash, level);
  else if (D.pb && D.pb.byId.has(fromHash)) open("problems", level, { startProblem: fromHash });
  else if (D.lab && (D.lab.byId.has(fromHash) || D.lab.bossById.has(fromHash))) open("lab", level, { startScenario: fromHash });
  else home();

  // Installable / offline: only when served over http(s) (service workers can't run from file://).
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
