/* Interactive puzzles: Swap Sort (adjacent swaps vs. inversions) and Binary Hunt (search with a flip budget). */
(function () {
  "use strict";
  const D = window.DSA, U = D.util;
  const PUZZLES = 3;

  function shell(root, mode, level, extraStats) {
    const lv = D.LEVELS[level - 1].name;
    root.innerHTML = `
      <div class="game">
        <div class="game-top">
          <button class="btn ghost back" type="button">← All games</button>
          <div class="game-title"><h2>${mode.name}</h2><span class="pill lvl-${level}">${lv}</span></div>
          <div class="stats">
            <div class="stat"><span>Puzzle</span><b data-s="p">1/${PUZZLES}</b></div>
            ${extraStats.map(([k, label]) => `<div class="stat"><span>${label}</span><b data-s="${k}">0</b></div>`).join("")}
            <div class="stat"><span>Score</span><b data-s="score">0</b></div>
          </div>
        </div>
        <div class="progress-dots" aria-hidden="true">${"<i></i>".repeat(PUZZLES)}</div>
        <div class="stage"></div>
      </div>`;
    return root;
  }

  function resultsView(stage, mode, level, st, cfg, lines) {
    const res = D.progress.record(mode.id, level, { score: st.score, correct: st.solved, total: PUZZLES });
    const lv = D.LEVELS[level - 1].name;
    stage.innerHTML = `
      <div class="results">
        <div class="eyebrow">Round complete · ${lv}</div>
        <div class="result-row">
          <div><div class="big">${st.score}</div><div class="cap">points${res.newBest ? " · new best" : ""}</div></div>
          <div><div class="big">${st.solved}/${PUZZLES}</div><div class="cap">${level <= 2 ? "solved at par" : "solved"}</div></div>
          <div><div class="big">+${res.xp}</div><div class="cap">XP${res.firstMastery ? " · mastery bonus" : ""}</div></div>
        </div>
        <ol class="review plain">${lines.map((l) => `<li>${l}</li>`).join("")}</ol>
        <p class="verdict">${res.firstMastery ? `You earned the <b>${lv}</b> badge for ${mode.name}.` : st.solved === PUZZLES ? "Clean sweep." : "Try again to master this level."}</p>
        <div class="actions">
          <button class="btn primary again" type="button">Play again</button>
          ${level < 4 ? `<button class="btn harder" type="button">Try ${D.LEVELS[level].name}</button>` : ""}
          <button class="btn ghost home" type="button">All games</button>
        </div>
      </div>`;
    stage.querySelector(".again").addEventListener("click", () => cfg.restart(level));
    const h = stage.querySelector(".harder");
    if (h) h.addEventListener("click", () => cfg.restart(level + 1));
    stage.querySelector(".home").addEventListener("click", () => cfg.exit());
    stage.querySelector(".again").focus({ preventScroll: true });
  }

  /* ================= Swap Sort ================= */
  const SWAP = { 1: { n: 6, slack: Infinity }, 2: { n: 8, slack: Infinity }, 3: { n: 10, slack: 2 }, 4: { n: 12, slack: 0 } };
  const inversions = (a) => { let c = 0; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (a[i] > a[j]) c++; return c; };

  function mountSwap(root, cfg) {
    const mode = cfg.mode, level = cfg.level, conf = SWAP[level];
    shell(root, mode, level, [["swaps", "Swaps"], ["par", "Par"], ["inv", "Inversions"]]);
    const $ = (s) => root.querySelector(s);
    $(".back").addEventListener("click", () => cfg.exit());
    const stage = $(".stage");
    const dots = [...root.querySelectorAll(".progress-dots i")];
    const st = { p: 0, score: 0, solved: 0, lines: [] };
    let g;

    function newPuzzle() {
      const n = conf.n, maxInv = (n * (n - 1)) / 2;
      let a;
      do a = U.shuffle(U.range(n).map((i) => i + 1)); while (inversions(a) < maxInv * 0.3 || inversions(a) > maxInv * 0.7);
      g = { start: a.slice(), arr: a, swaps: 0, par: inversions(a), sel: null, done: false, failed: false };
      dots.forEach((d, k) => d.classList.toggle("cur", k === st.p));
      const limitTxt = conf.slack === Infinity ? "Any number of swaps is allowed, but matching par earns three stars." : conf.slack === 0 ? "You have <b>exactly par</b> swaps. One wasted swap and the puzzle is lost." : `You may use at most <b>par + ${conf.slack}</b> swaps.`;
      stage.innerHTML = `
        <div class="q">
          <div class="q-meta"><span class="tag">Inversions</span><span class="kind">Tap a bar, then a neighbour</span></div>
          <div class="prompt">Sort the bars from shortest to tallest by swapping <b>neighbours</b> only. ${limitTxt}</div>
          <div class="bars" style="--n:${n}"></div>
          <p class="hintline">An inversion is a pair of bars in the wrong order. A useful swap removes exactly one.</p>
          <div class="feedback" role="status" hidden></div>
          <div class="actions">
            <button class="btn ghost reset" type="button">Restart puzzle</button>
            <button class="btn primary next" type="button" hidden></button>
          </div>
        </div>`;
      stage.querySelector(".reset").addEventListener("click", () => { if (g.done) return; g.arr = g.start.slice(); g.swaps = 0; g.sel = null; g.failed = false; feedback(""); render(); });
      stage.querySelector(".next").addEventListener("click", advance);
      render();
    }

    function feedback(html, kind) {
      const fb = stage.querySelector(".feedback");
      fb.hidden = !html;
      fb.innerHTML = html ? `<p${kind ? ` class="${kind}"` : ""}>${html}</p>` : "";
    }

    function render(focusIdx) {
      const box = stage.querySelector(".bars");
      box.innerHTML = "";
      g.arr.forEach((v, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "bar" + (g.sel === i ? " sel" : "") + (g.sel !== null && Math.abs(g.sel - i) === 1 ? " nbr" : "") + (g.done && !g.failed ? " ok" : "") + (g.failed ? " lost" : "");
        b.style.setProperty("--h", 14 + (v / conf.n) * 86 + "%");
        b.setAttribute("aria-label", `Bar ${v}, position ${i + 1}${g.sel === i ? ", selected" : ""}`);
        b.disabled = g.done;
        b.innerHTML = `<span class="fill"></span><span class="lbl">${v}</span>`;
        b.addEventListener("click", () => tap(i));
        box.appendChild(b);
      });
      $('[data-s="p"]').textContent = `${st.p + 1}/${PUZZLES}`;
      $('[data-s="swaps"]').textContent = g.swaps + (conf.slack !== Infinity ? `/${g.par + conf.slack}` : "");
      $('[data-s="par"]').textContent = g.par;
      $('[data-s="inv"]').textContent = inversions(g.arr);
      $('[data-s="score"]').textContent = st.score;
      if (focusIdx != null && box.children[focusIdx]) box.children[focusIdx].focus({ preventScroll: true });
    }

    function tap(i) {
      if (g.done) return;
      const s = g.sel;
      if (s === null || s === i || Math.abs(s - i) !== 1) { g.sel = s === i ? null : i; render(i); return; }
      const a = g.arr, lo = Math.min(s, i);
      const helpful = a[lo] > a[lo + 1];
      [a[s], a[i]] = [a[i], a[s]];
      g.swaps++;
      g.sel = null;
      const inv = inversions(a), limit = g.par + conf.slack;
      if (inv === 0) {
        const over = g.swaps - g.par;
        const stars = over === 0 ? 3 : over <= 2 ? 2 : 1;
        const pts = stars * 100 * level;
        st.score += pts;
        const atPar = over === 0;
        if (level <= 2 ? atPar : true) st.solved++;
        dots[st.p].classList.add(level <= 2 ? (atPar ? "ok" : "meh") : "ok");
        st.lines.push(`Puzzle ${st.p + 1}: ${"★".repeat(stars)}${"☆".repeat(3 - stars)}, ${g.swaps} swaps (par ${g.par})`);
        g.done = true;
        feedback(`<strong class="win">${"★".repeat(stars)}${"☆".repeat(3 - stars)} +${pts}</strong> Sorted in ${g.swaps} swaps${atPar ? ", exactly par. That's the number bubble sort makes." : `, ${over} over par. Each swap of an already-ordered pair adds an inversion you later have to undo.`}`);
      } else if (g.swaps + inv > limit) {
        g.done = true;
        g.failed = true;
        dots[st.p].classList.add("bad");
        st.lines.push(`Puzzle ${st.p + 1}: out of swaps (par ${g.par})`);
        feedback(`<strong class="lose">Out of swaps.</strong> ${inv} inversions remain but only ${Math.max(0, limit - g.swaps)} swaps are left. Only swap neighbours that are out of order.`);
      } else if (!helpful) {
        feedback("That pair was already in order, so the swap added an inversion.", "lose");
      } else feedback("");
      render(g.done ? null : i);
      if (g.done) {
        const nx = stage.querySelector(".next");
        nx.hidden = false;
        nx.textContent = st.p === PUZZLES - 1 ? "See results" : "Next puzzle";
        nx.focus({ preventScroll: true });
        stage.querySelector(".reset").hidden = true;
      }
    }

    function advance() {
      st.p++;
      if (st.p >= PUZZLES) {
        dots.forEach((d) => d.classList.remove("cur"));
        $('[data-s="score"]').textContent = st.score;
        return resultsView(stage, mode, level, st, cfg, st.lines);
      }
      newPuzzle();
    }

    newPuzzle();
    return { destroy() {} };
  }

  /* ================= Binary Hunt ================= */
  const HUNT = {
    1: { n: 15, flips: 4, absent: false, dupes: false },
    2: { n: 31, flips: 5, absent: false, dupes: false },
    3: { n: 63, flips: 6, absent: true, dupes: false },
    4: { n: 63, flips: 6, absent: false, dupes: true },
  };

  function mountHunt(root, cfg) {
    const mode = cfg.mode, level = cfg.level, conf = HUNT[level];
    shell(root, mode, level, [["left", "Flips left"], ["size", "Candidates"]]);
    const $ = (s) => root.querySelector(s);
    $(".back").addEventListener("click", () => cfg.exit());
    const stage = $(".stage");
    const dots = [...root.querySelectorAll(".progress-dots i")];
    const st = { p: 0, score: 0, solved: 0, lines: [] };
    let hint = !!D.store.get("hunt-hint", false);
    let g;

    function newHunt() {
      let vals, target;
      if (conf.dupes) {
        vals = [];
        let v = U.randInt(1, 5);
        while (vals.length < conf.n) { const reps = Math.random() < 0.25 ? U.randInt(2, 6) : 1; for (let r = 0; r < reps && vals.length < conf.n; r++) vals.push(v); v += U.randInt(1, 6); }
        const dupVals = U.uniq(vals).filter((x) => vals.filter((y) => y === x).length >= 3);
        target = dupVals.length ? U.pick(dupVals) : U.pick(vals);
      } else {
        vals = U.distinctInts(conf.n, 1, conf.n * 8).sort((a, b) => a - b);
        target = vals[U.rand(conf.n)];
        if (conf.absent && Math.random() < 0.5) {
          const set = new Set(vals);
          do target = U.randInt(vals[0] + 1, vals[vals.length - 1] - 1); while (set.has(target));
        }
      }
      g = { vals, target, lo: 0, hi: conf.n - 1, left: conf.flips, probed: new Set(), done: false, won: false, log: [], cand: -1 };
      dots.forEach((d, k) => d.classList.toggle("cur", k === st.p));
      const goal = conf.dupes
        ? `The sorted list contains <b>duplicates</b>. Find the index of the <b>first</b> <span class="target-inline">${target}</span>. Flipping a match isn't enough: keep narrowing until the live range is empty.`
        : conf.absent
        ? `Find <span class="target-inline">${target}</span>, or prove it's <b>not there</b> by shrinking the live range to nothing.`
        : `Find <span class="target-inline">${target}</span>.`;
      stage.innerHTML = `
        <div class="q">
          <div class="q-meta"><span class="tag">Binary search</span><span class="kind">${conf.n} cards · ${conf.flips} flips · ⌈log₂ ${conf.n + 1}⌉ = ${Math.ceil(Math.log2(conf.n + 1))}</span></div>
          <div class="prompt">${conf.n} numbers are hidden in sorted order. ${goal} Each flip tells you which way to go.</div>
          <div class="range"></div>
          <div class="cells"></div>
          <div class="feedback" role="status" hidden></div>
          <ol class="log"></ol>
          <div class="actions">
            <label class="toggle"><input type="checkbox" class="hint" ${hint ? "checked" : ""}> Mark the midpoint</label>
            <button class="btn primary next" type="button" hidden></button>
          </div>
        </div>`;
      stage.querySelector(".hint").addEventListener("change", (e) => { hint = e.target.checked; D.store.set("hunt-hint", hint); render(); });
      stage.querySelector(".next").addEventListener("click", advance);
      render();
    }

    function render(focusIdx) {
      const box = stage.querySelector(".cells");
      const mid = Math.floor((g.lo + g.hi) / 2);
      box.innerHTML = "";
      g.vals.forEach((v, i) => {
        const c = document.createElement("button");
        c.type = "button";
        const live = i >= g.lo && i <= g.hi;
        const shown = g.done || g.probed.has(i);
        const isAns = conf.dupes ? i === g.vals.indexOf(g.target) : v === g.target;
        c.className = "cell" + (!live && !g.done ? " dead" : "") + (g.probed.has(i) ? " probed" : "") + (g.done && isAns ? (g.won ? " found" : " answer") : "") + (hint && live && i === mid && !g.done ? " mid" : "") + (i === g.cand && !g.done ? " cand" : "");
        c.disabled = g.done || !live;
        c.innerHTML = `<span class="v">${shown ? v : "?"}</span><span class="i">${i}</span>`;
        c.setAttribute("aria-label", `Index ${i}${shown ? `, value ${v}` : ", hidden"}${!live && !g.done ? ", ruled out" : ""}`);
        c.addEventListener("click", () => flip(i));
        box.appendChild(c);
      });
      stage.querySelector(".range").innerHTML = g.done ? "" : g.lo <= g.hi ? `Live range: indices <b>[${g.lo} … ${g.hi}]</b>` : "Live range is empty.";
      stage.querySelector(".log").innerHTML = g.log.map((l) => `<li>${l}</li>`).join("");
      $('[data-s="p"]').textContent = `${st.p + 1}/${PUZZLES}`;
      $('[data-s="left"]').textContent = g.left;
      $('[data-s="size"]').textContent = g.done ? "–" : Math.max(0, g.hi - g.lo + 1);
      $('[data-s="score"]').textContent = st.score;
      if (focusIdx != null && box.children[focusIdx] && !box.children[focusIdx].disabled) box.children[focusIdx].focus({ preventScroll: true });
    }

    function feedback(html) {
      const fb = stage.querySelector(".feedback");
      fb.hidden = false;
      fb.innerHTML = `<p>${html}</p>`;
    }

    function flip(i) {
      if (g.done || i < g.lo || i > g.hi) return;
      const mid = Math.floor((g.lo + g.hi) / 2), v = g.vals[i], t = g.target;
      g.probed.add(i);
      g.left--;
      let line = `Index ${i} holds <b>${v}</b>. `;
      let found = false;
      if (v === t && !conf.dupes) { line += "That's the target."; found = true; }
      else if (v === t) { line += `A match. Remember it, then keep searching left for an earlier ${t}.`; g.cand = i; g.hi = i - 1; }
      else if (v < t) { line += `${v} &lt; ${t}, so go right.`; g.lo = i + 1; }
      else { line += `${v} &gt; ${t}, so go left.`; g.hi = i - 1; }
      line += i === mid ? " A perfect split." : ` The midpoint was index ${mid}.`;
      g.log.push(line);
      const used = conf.flips - g.left;
      const finish = (won, msg) => {
        g.done = true; g.won = won;
        if (won) { const pts = (100 + g.left * 50) * level; st.score += pts; st.solved++; dots[st.p].classList.add("ok"); feedback(`<strong class="win">+${pts}</strong> ${msg}`); }
        else { dots[st.p].classList.add("bad"); feedback(`<strong class="lose">Out of flips.</strong> ${msg}`); }
        st.lines.push(`Hunt ${st.p + 1}: ${won ? `solved in ${used} flip${used === 1 ? "" : "s"}` : "out of flips"}`);
        const nx = stage.querySelector(".next");
        nx.hidden = false;
        nx.textContent = st.p === PUZZLES - 1 ? "See results" : "Next hunt";
        nx.focus({ preventScroll: true });
      };
      if (found) finish(true, `Found ${t} in ${used} flip${used === 1 ? "" : "s"}. A linear scan would have needed ${i + 1}.`);
      else if (g.lo > g.hi) {
        if (conf.dupes) finish(true, `The range is empty, so the first ${t} is at index ${g.cand}. This is lower_bound, the basis of bisect_left.`);
        else finish(true, `The range is empty, which proves ${t} isn't in the list.`);
      } else if (g.left === 0) {
        const where = conf.dupes ? `The first ${t} was at index ${g.vals.indexOf(t)}.` : g.vals.includes(t) ? `${t} was at index ${g.vals.indexOf(t)}.` : `${t} wasn't in the list.`;
        finish(false, `${where} Always flipping the middle of the live range guarantees success within ${conf.flips}.`);
      }
      render(g.done ? null : Math.floor((g.lo + g.hi) / 2));
    }

    function advance() {
      st.p++;
      if (st.p >= PUZZLES) {
        dots.forEach((d) => d.classList.remove("cur"));
        return resultsView(stage, mode, level, st, cfg, st.lines);
      }
      newHunt();
    }

    newHunt();
    return { destroy() {} };
  }

  D.registerMode({
    id: "swap", name: "Swap Sort", group: "Puzzles", topic: "Arrays · inversions",
    blurb: "Sort bars with neighbour swaps only. Par is the inversion count.",
    custom: true, mount: mountSwap, rounds: PUZZLES,
  });
  D.registerMode({
    id: "hunt", name: "Binary Hunt", group: "Puzzles", topic: "Searching",
    blurb: "Find a hidden number with a log₂ n flip budget. Later tiers add missing targets and duplicates.",
    custom: true, mount: mountHunt, rounds: PUZZLES,
  });
})();
