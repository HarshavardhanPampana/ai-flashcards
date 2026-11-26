"use strict";
const $ = (id) => document.getElementById(id);

const CAT_LABEL = {
  model_release: "Model release", paper: "Paper", product: "Product", funding: "Funding",
  acquisition: "Acquisition", policy: "Policy", hardware: "Hardware", open_source: "Open source", other: "Other",
};
const catName = (c) => CAT_LABEL[c] || String(c || "other").replace(/_/g, " ");
const catKey = (c) => (CAT_LABEL[c] ? c : "other");

// ---------- per-browser storage (always optional) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let progress = store.get("progress", {});
let picks = store.get("picks", {});          // id -> "keep" | "skip"
const state = { cat: "", time: "all", q: "", minImp: 1, review: "", sort: "top", semantic: false };
Object.assign(state, store.get("filters", {}), { q: "" });

// "New since last visit": a visit = a session separated by 30+ minutes
const now = Date.now();
const visits = store.get("visits", { current: 0, previous: 0 });
if (now - visits.current > 30 * 60 * 1000) { visits.previous = visits.current; visits.current = now; }
store.set("visits", visits);
const lastVisit = visits.previous;

let cards = [];
let view = [];
let byId = new Map();

// ---------- helpers ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
const ts = (d) => { const t = Date.parse(d || ""); return isNaN(t) ? 0 : t; };
function ago(d) {
  const t = ts(d); if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  if (s < 86400 * 7) return Math.round(s / 86400) + "d ago";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
let images = {};
const shortModel = (m) => String(m || "LLM").split("/").pop().replace(/-instruct$/i, "");
const isNew = (c) => lastVisit && ts(c.added) > lastVisit;
const stars = (n) => { n = Math.max(1, Math.min(5, n || 1)); return "★".repeat(n) + `<span class="off">${"★".repeat(5 - n)}</span>`; };

// ---------- load ----------
async function load() {
  $("grid").innerHTML = Array.from({ length: 6 }, () =>
    `<div class="card skel"><div class="inner"><div class="face"></div></div></div>`).join("");
  try {
    const res = await fetch("cards.json?t=" + Date.now()); // bypass cache
    cards = await res.json();
    try {                                                   // diffusion cover images (optional)
      const im = await fetch("images.json?t=" + Date.now()).then((r) => (r.ok ? r.json() : {}));
      images = im.images || {};
    } catch { images = {}; }
  } catch {
    $("grid").innerHTML = `<div class="empty"><b>Couldn't load cards.json</b>Serve this folder over http (not file://).</div>`;
    $("updated").textContent = "";
    return;
  }
  cards.forEach((c) => {
    c._cat = catKey(c.category); c._img = images[c.id] || "";
    c._text = [c.headline, c.tldr, c.why_it_matters, c.source, ...(c.key_points || []), ...(c.tags || []),
      ...(c.companies || []), c.category].join(" ").toLowerCase();
  });
  byId = new Map(cards.map((c) => [c.id, c]));
  syncSem();
  const latest = Math.max(0, ...cards.map((c) => ts(c.added)));
  const fresh = cards.filter(isNew).length;
  $("updated").innerHTML = latest
    ? `Updated ${esc(ago(new Date(latest).toISOString()))}<span class="hide-sm"> · refreshes every 6 hours</span>` + (fresh ? ` · ${fresh} new for you` : "")
    : "No cards yet";
  buildChips();
  syncControls();
  render();
}

function buildChips() {
  const counts = {};
  cards.forEach((c) => { counts[c._cat] = (counts[c._cat] || 0) + 1; });
  const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (state.cat && !counts[state.cat]) state.cat = "";
  $("chips").innerHTML =
    `<button type="button" class="chip${state.cat ? "" : " on"}" data-cat="">All <span class="n">${cards.length}</span></button>` +
    cats.map((c) => `<button type="button" class="chip${state.cat === c ? " on" : ""}" data-cat="${c}" style="--c:var(--c-${c})">
      <span class="dot"></span>${esc(catName(c))} <span class="n">${counts[c]}</span></button>`).join("");
}

function syncControls() {
  $("importance").value = String(state.minImp);
  $("review").value = state.review;
  $("sort").value = state.sort;
  document.querySelectorAll("#time button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.time));
}

// ---------- filter + render ----------
function filtered(opts = {}) {
  const review = opts.ignorePicked && state.review === "picked" ? "" : state.review;
  const q = state.q.trim().toLowerCase();
  const day = 86400 * 1000;
  return cards
    .filter((c) => !state.cat || c._cat === state.cat)
    .filter((c) => (c.importance || 1) >= state.minImp)
    .filter((c) => !review ||
      (review === "picked" ? picks[c.id] === "keep"
        : review === "todo" ? !progress[c.id] : progress[c.id] === review))
    .filter((c) => state.time === "all" ||
      (state.time === "new" ? isNew(c) : now - ts(c.added) < (state.time === "today" ? day : 7 * day)))
    .filter((c) => !q || (semanticOn() ? (simById.get(c.id) ?? -1) >= SIM_MIN
      : q.split(/\s+/).every((w) => c._text.includes(w))))
    .sort((a, b) => semanticOn() ? (simById.get(b.id) ?? -1) - (simById.get(a.id) ?? -1)
      : state.sort === "new"
      ? ts(b.added) - ts(a.added) || ts(b.date) - ts(a.date)
      : (b.importance || 1) - (a.importance || 1) || ts(b.added) - ts(a.added));
}

function cardHTML(c, layout = "") {
  const st = progress[c.id];
  const rel = (c.related || []).map((id) => byId.get(id)).filter(Boolean).slice(0, 3);
  const sim = semanticOn() ? simById.get(c.id) : null;
  return `
  <div class="card ${layout} ${st ? "st-" + st : ""}${c._img ? " has-img" : ""}" data-id="${esc(c.id)}" style="--c:var(--c-${c._cat})"
       tabindex="0" role="button" aria-label="${esc(c.headline)}. Press Enter to flip.">
    <span class="badge-state" aria-hidden="true">${st === "got" ? "✓" : st === "again" ? "↻" : ""}</span>
    <div class="inner">
      <div class="face front">
        ${c._img ? `<div class="thumb"><img src="${esc(c._img)}" alt="" loading="lazy" decoding="async"></div>` : ""}
        <div class="meta">
          ${layout.includes("hero") ? `<span class="ribbon">Top story</span>` : ""}
          <span class="cat">${esc(catName(c._cat))}</span>
          ${isNew(c) ? `<span class="new">NEW</span>` : ""}
          ${picks[c.id] === "keep" ? `<span class="picked-heart" title="In your picks">♥</span>` : ""}
          ${sim != null ? `<span class="match" title="How close this card is in meaning to your search">${Math.round(sim * 100)}% match</span>` : ""}
          <span class="stars" title="Importance ${c.importance || 1}/5">${stars(c.importance)}</span>
        </div>
        <h3>${esc(c.headline)}</h3>
        <p class="tldr">${esc(c.tldr)}</p>
        ${layout.includes("hero") && (c.key_points || []).length
          ? `<ul class="hero-points">${c.key_points.slice(0, 3).map((k) => `<li>${esc(k)}</li>`).join("")}</ul>` : ""}
        <div class="tags">${(c.tags || []).slice(0, 4).map((t) => `<span>${esc(t)}</span>`).join("")}</div>
        <div class="foot">
          <span class="src">${esc(c.source)}</span><span>· ${esc(ago(c.date) || ago(c.added))}</span>
          <span class="flip-hint"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 1l4 4-4 4V6H7a3 3 0 0 0-3 3v1H2V9a5 5 0 0 1 5-5h10zM7 23l-4-4 4-4v3h10a3 3 0 0 0 3-3v-1h2v1a5 5 0 0 1-5 5H7z"/></svg>Flip</span>
        </div>
      </div>
      <div class="face back">
        <div class="scroll">
          ${(c.key_points || []).length ? `<h4>Key points</h4><ul>${c.key_points.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>` : ""}
          ${c.why_it_matters ? `<h4>Why it matters</h4><p>${esc(c.why_it_matters)}</p>` : ""}
          ${(c.companies || []).length ? `<p class="companies">${c.companies.map(esc).join(" · ")}</p>` : ""}
          ${rel.length ? `<h4>Related stories</h4><div class="rel">${rel.map((r) =>
            `<button type="button" data-rel="${esc(r.id)}" style="--c:var(--c-${r._cat})">${esc(r.headline)}</button>`).join("")}</div>` : ""}
          <div class="ai-labels">
            <span title="This card was written and rated by this LLM">🤖 ${esc(shortModel(c.model))} · ★${c.importance || 1} · ${esc(catName(c._cat))}</span>
            ${c.mlp ? `<span title="Predicted by the MLP from the raw story, before the LLM saw it">🧠 MLP · ★${c.mlp.importance} · ${esc(catName(c.mlp.category))}</span>` : ""}
          </div>
        </div>
        <div class="actions">
          <a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener">Read source ↗</a>
          <button type="button" class="mark" data-mark="got">✓ Got it</button>
          <button type="button" class="mark" data-mark="again">↻ Again</button>
        </div>
      </div>
    </div>
  </div>`;
}

// Draw cards a page at a time so the page stays fast with hundreds of cards
const PAGE = 60;
let shown = PAGE;

// Magazine layout: the first card is a big "Top story", 4-5 star cards are wide
// (at most one wide card in any run of 5, so it stays a rhythm and not a wall)
let lastWide = -99;
function layoutFor(c, i) {
  const cls = ["pre"];
  if (i === 0) lastWide = -99;
  if (i === 0 && view.length > 3) cls.push("hero");
  else if ((c.importance || 1) >= 4 && i - lastWide >= 5) { cls.push("wide"); lastWide = i; }
  return cls.join(" ");
}
const gridCards = (from, to) => view.slice(from, to).map((c, k) => cardHTML(c, layoutFor(c, from + k))).join("");

function moreHTML() {
  const left = view.length - shown;
  return left > 0
    ? `<div class="more"><button type="button" class="btn" id="more">Show ${Math.min(PAGE, left)} more · ${left} left</button></div>`
    : "";
}
function updateCount() {
  const filteredOut = view.length !== cards.length;
  $("count").textContent = !cards.length ? ""
    : `Showing ${Math.min(shown, view.length)} of ${view.length}${filteredOut ? " matching" : ""} cards${semanticOn() ? " by meaning" : ""}`
      + (filteredOut ? ` (${cards.length} total)` : "");
}
function render(keepPage = false) {
  view = filtered();
  if (!keepPage) shown = PAGE;
  $("grid").innerHTML = view.length ? gridCards(0, shown) + moreHTML() : emptyHTML();
  observeCards();
  updateCount();
  updateProgress();
  store.set("filters", { cat: state.cat, time: state.time, minImp: state.minImp, review: state.review, sort: state.sort, semantic: state.semantic });
}

function emptyHTML() {
  if (!cards.length) return `<div class="empty"><b>No cards yet</b>The scraper runs every 6 hours. Check back soon.</div>`;
  if (state.review === "picked" && !Object.values(picks).includes("keep"))
    return `<div class="empty"><b>No picks yet</b>Press <b>Pick</b> (or <kbd>P</kbd>) and swipe right on the cards you want.</div>`;
  const why = state.time === "new" ? "Nothing new since your last visit." : "No cards match these filters.";
  return `<div class="empty"><b>${why}</b><button type="button" class="btn" id="reset">Clear filters</button></div>`;
}

function updateProgress() {
  const got = cards.filter((c) => progress[c.id] === "got").length;
  const pct = cards.length ? Math.round((got / cards.length) * 100) : 0;
  $("bar").style.width = pct + "%";
  $("progress").textContent = `${got} / ${cards.length} learned`;
}

function mark(id, how) {
  progress[id] = progress[id] === how ? undefined : how;
  if (!progress[id]) delete progress[id];
  store.set("progress", progress);
  updateProgress();
  return progress[id];
}

function applyMarkClass(el, st) {
  el.classList.remove("st-got", "st-again");
  if (st) el.classList.add("st-" + st);
  const b = el.querySelector(".badge-state");
  if (b) b.textContent = st === "got" ? "✓" : st === "again" ? "↻" : "";
}

// ---------- events: grid ----------
$("grid").addEventListener("click", (e) => {
  if (e.target.closest("#reset")) {
    Object.assign(state, { cat: "", time: "all", q: "", minImp: 1, review: "" });
    $("search").value = ""; buildChips(); syncControls(); render(); return;
  }
  if (e.target.closest("#more")) {      // append the next page without redrawing the rest
    const from = shown; shown += PAGE;
    e.target.closest(".more").remove();
    $("grid").insertAdjacentHTML("beforeend", gridCards(from, shown) + moreHTML());
    observeCards();
    updateCount();
    return;
  }
  const card = e.target.closest(".card");
  if (!card || card.classList.contains("skel") || e.target.closest("a")) return;
  const relBtn = e.target.closest("[data-rel]");
  if (relBtn) {                          // open the related story (and its own related ones) in study mode
    const r = byId.get(relBtn.dataset.rel);
    if (r) openStudy([r, ...(r.related || []).map((id) => byId.get(id)).filter(Boolean)]);
    return;
  }
  const btn = e.target.closest("button[data-mark]");
  if (btn) {
    applyMarkClass(card, mark(card.dataset.id, btn.dataset.mark));
    if (state.review) setTimeout(() => render(true), 250);   // card may no longer match the status filter
    return;
  }
  flipOnly(card);
});
$("grid").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("card")) {
    e.preventDefault(); flipOnly(e.target);
  }
});
// Only one card is flipped at a time: flipping a card turns any other flipped card back to its front
function flipOnly(card) {
  $("grid").querySelectorAll(".card.flipped").forEach((c) => { if (c !== card) c.classList.remove("flipped"); });
  card.classList.toggle("flipped");
}

// ---------- events: controls ----------
$("chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip"); if (!chip) return;
  state.cat = chip.dataset.cat;
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === chip));
  render();
});
$("time").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.time = b.dataset.v; syncControls(); render();
});
let searchTimer;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value;
    if (state.semantic) runSemantic(state.q); else render();
  }, state.semantic ? 300 : 120);
});
$("importance").addEventListener("change", (e) => { state.minImp = +e.target.value; render(); });
$("review").addEventListener("change", (e) => { state.review = e.target.value; render(); });
$("sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });

$("theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch {}
});

// ---------- study mode ----------
let si = 0, deck = [];
function openStudy(list) {
  // unreviewed and "review again" cards first, "got it" last
  const rank = (c) => (progress[c.id] === "got" ? 2 : progress[c.id] === "again" ? 0 : 1);
  deck = Array.isArray(list) ? list : filtered().slice().sort((a, b) => rank(a) - rank(b));
  if (!deck.length) return;
  si = 0;
  $("studyView").hidden = false;
  document.body.classList.add("studying");
  showStudy("");
}
function closeStudy() {
  $("studyView").hidden = true;
  document.body.classList.remove("studying");
  render();
  $("study").focus();
}
function showStudy(dir) {
  const c = deck[si];
  $("studyStage").innerHTML = cardHTML(c);
  const el = $("studyStage").firstElementChild;
  if (dir) el.classList.add(dir === "next" ? "slide-l" : "slide-r");
  el.focus({ preventScroll: true });   // so Space flips the card, not a focused button
  const learned = deck.filter((d) => progress[d.id] === "got").length;
  $("studyPos").textContent = `Card ${si + 1} of ${deck.length} · ${learned} learned`;
  $("prev").disabled = si === 0;
  $("next").textContent = si === deck.length - 1 ? "Done ✓" : "Next →";
}
function step(d) {
  const n = si + d;
  if (n >= deck.length) return closeStudy();
  if (n < 0) return;
  si = n; showStudy(d > 0 ? "next" : "prev");
}
function studyMark(how) {
  if (progress[deck[si].id] !== how) mark(deck[si].id, how);
  setTimeout(() => step(1), 180);
  applyMarkClass($("studyStage").firstElementChild, how);
}
$("study").addEventListener("click", () => openStudy());
$("studyClose").addEventListener("click", closeStudy);
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
$("got").addEventListener("click", () => studyMark("got"));
$("again").addEventListener("click", () => studyMark("again"));
$("studyStage").addEventListener("click", (e) => {
  const card = e.target.closest(".card"); if (!card || e.target.closest("a")) return;
  const relBtn = e.target.closest("[data-rel]");
  if (relBtn) {                       // jump to a related story: insert it right after this card
    const r = byId.get(relBtn.dataset.rel);
    if (r) {
      const cur = deck[si];
      deck = deck.filter((d) => d !== r); si = deck.indexOf(cur);
      deck.splice(si + 1, 0, r); step(1);
    }
    return;
  }
  const btn = e.target.closest("button[data-mark]");
  if (btn) return studyMark(btn.dataset.mark);
  card.classList.toggle("flipped");
});
// swipe on touch screens
let tx = null, ty = null;
$("studyStage").addEventListener("touchstart", (e) => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
$("studyStage").addEventListener("touchend", (e) => {
  if (tx == null) return;
  const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  tx = ty = null;
});

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  if (!$("pickView").hidden) {
    if (e.key === "Escape") closePick();
    else if (e.key === "ArrowRight") decide(1);
    else if (e.key === "ArrowLeft") decide(-1);
    else if (e.key.toLowerCase() === "z" || e.key === "Backspace") { e.preventDefault(); undo(); }
    else if (e.key === " " || e.key === "Enter") {
      if (document.activeElement?.closest?.(".pick-nav, .study-top, .actions, .pick-done")) return;
      e.preventDefault(); topCard()?.classList.toggle("flipped");
    }
    return;
  }
  if (!$("studyView").hidden) {
    if (e.key === "Escape") closeStudy();
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === " " || e.key === "Enter") {
      if (document.activeElement?.closest?.(".study-nav, .study-top, .actions")) return;
      e.preventDefault(); $("studyStage").firstElementChild?.classList.toggle("flipped");
    }
    else if (e.key === "1") studyMark("got");
    else if (e.key === "2") studyMark("again");
    return;
  }
  if (typing) { if (e.key === "Escape") document.activeElement.blur(); return; }
  if (e.key === "/") { e.preventDefault(); $("search").focus(); }
  else if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey) openStudy();
  else if (e.key.toLowerCase() === "p" && !e.ctrlKey && !e.metaKey) openPick();
});

// ---------- pick mode: swipe right = keep, left = skip ----------
let pdeck = [], pi = 0, phist = [];
const topCard = () => $("pickStage").querySelector(".card.top");

function openPick() {
  if (!$("studyView").hidden) return;
  pdeck = filtered({ ignorePicked: true }).filter((c) => !picks[c.id]);
  pi = 0; phist = [];
  $("pickView").hidden = false;
  document.body.classList.add("studying");
  renderPick();
}
function closePick() {
  $("pickView").hidden = true;
  document.body.classList.remove("studying");
  render();
  $("pick").focus();
}
const keptCount = () => Object.values(picks).filter((v) => v === "keep").length;

function renderPick() {
  const stage = $("pickStage");
  $("pickUndo").disabled = !phist.length;
  if (pi >= pdeck.length) {
    const n = keptCount();
    const pool = filtered({ ignorePicked: true }).length;
    $("pickPos").textContent = `♥ ${n} kept`;
    $("pickSkip").disabled = $("pickKeep").disabled = true;
    stage.innerHTML = `<div class="pick-done">
      <div class="big">${n ? "🎉" : "🗂️"}</div>
      <h3>${pdeck.length ? "All done!" : "You've already sorted these"}</h3>
      <p class="muted">${n ? `You've kept <b>${n}</b> card${n > 1 ? "s" : ""} to study.` : "You haven't kept any cards yet."}
        ${pool ? `(${pool} card${pool > 1 ? "s" : ""} match your current filters.)` : ""}</p>
      <div class="row">
        ${n ? `<button type="button" class="btn primary" data-do="study">▶ Study my picks</button>
               <button type="button" class="btn" data-do="show">See my picks</button>` : ""}
        <button type="button" class="btn" data-do="restart">↺ Sort again</button>
      </div></div>`;
    stage.querySelector(".pick-done .btn")?.focus();
    return;
  }
  $("pickSkip").disabled = $("pickKeep").disabled = false;
  $("pickPos").textContent = `${pi + 1} of ${pdeck.length} · ♥ ${keptCount()} kept`;
  const layers = pdeck.slice(pi, pi + 3);
  stage.innerHTML = layers.map((c, i) => cardHTML(c)
      .replace('class="card', `class="card ${["top", "under", "under2"][i]}`)
      .replace('<div class="inner">', i === 0
        ? '<span class="stamp keep">KEEP</span><span class="stamp skip">SKIP</span><div class="inner">'
        : '<div class="inner">'))
    .reverse().join("");          // top card last so it sits on top
  const el = topCard();
  el.setAttribute("aria-label", el.getAttribute("aria-label").replace("Press Enter to flip.", "Right arrow keeps, left arrow skips."));
  el.focus({ preventScroll: true });
}

function decide(dir) {
  const el = topCard();
  if (!el || el.dataset.gone) return;
  el.dataset.gone = "1";
  const c = pdeck[pi];
  picks[c.id] = dir > 0 ? "keep" : "skip";
  store.set("picks", picks);
  phist.push(c.id);
  el.style.transform = `translateX(${dir * 140}%) rotate(${dir * 24}deg)`;
  el.style.opacity = "0";
  el.querySelector(`.stamp.${dir > 0 ? "keep" : "skip"}`).style.opacity = "1";
  setTimeout(() => { pi++; renderPick(); }, 260);
}
function undo() {
  if (!phist.length) return;
  delete picks[phist.pop()];
  store.set("picks", picks);
  pi = Math.max(0, pi - 1);
  renderPick();
}

// drag / swipe (mouse and touch via pointer events)
let drag = null;
$("pickStage").addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".card.top");
  if (!el || el.dataset.gone || e.target.closest("a, button") || e.button > 0) return;
  drag = { el, x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
  el.classList.add("dragging");
  el.setPointerCapture(e.pointerId);
});
$("pickStage").addEventListener("pointermove", (e) => {
  if (!drag) return;
  drag.dx = e.clientX - drag.x; drag.dy = e.clientY - drag.y;
  drag.el.style.transform = `translate(${drag.dx}px, ${drag.dy * 0.25}px) rotate(${drag.dx / 16}deg)`;
  const k = Math.min(1, Math.abs(drag.dx) / 110);
  drag.el.querySelector(".stamp.keep").style.opacity = drag.dx > 0 ? k : 0;
  drag.el.querySelector(".stamp.skip").style.opacity = drag.dx < 0 ? k : 0;
});
function endDrag() {
  if (!drag) return;
  const { el, dx, dy } = drag; drag = null;
  el.classList.remove("dragging");
  if (Math.abs(dx) > 110) return decide(dx > 0 ? 1 : -1);
  el.style.transform = "";
  el.querySelectorAll(".stamp").forEach((s) => (s.style.opacity = 0));
  if (Math.abs(dx) < 6 && Math.abs(dy) < 6) el.classList.toggle("flipped");   // a tap flips
}
$("pickStage").addEventListener("pointerup", endDrag);
$("pickStage").addEventListener("pointercancel", endDrag);

$("pickStage").addEventListener("click", (e) => {
  const act = e.target.closest("[data-do]");
  if (act) {
    const what = act.dataset.do;
    if (what === "restart") {
      filtered({ ignorePicked: true }).forEach((c) => delete picks[c.id]);
      store.set("picks", picks);
      return openPick();
    }
    state.review = "picked";
    closePick(); syncControls(); render();
    if (what === "study") openStudy();
    return;
  }
  const btn = e.target.closest("button[data-mark]");
  if (btn) { const card = btn.closest(".card"); applyMarkClass(card, mark(card.dataset.id, btn.dataset.mark)); }
});
$("pick").addEventListener("click", openPick);
$("pickClose").addEventListener("click", closePick);
$("pickKeep").addEventListener("click", () => decide(1));
$("pickSkip").addEventListener("click", () => decide(-1));
$("pickUndo").addEventListener("click", undo);


// ---------- AI search by meaning (same MiniLM encoder as the pipeline, running in your browser) ----------
const SIM_MIN = 0.36;   // below this, a card is not really about your query
let encoder = null, encLoading = null, vecIds = [], vecs = null, dim = 384;
let simById = new Map(), simQuery = "";
const semanticOn = () => state.semantic && state.q.trim() && simQuery === state.q.trim() && simById.size > 0;
const setSemStatus = (t) => { $("semStatus").textContent = t; $("semStatus").hidden = !t; };
function syncSem() {
  $("semToggle").classList.toggle("on", !!state.semantic);
  $("semToggle").setAttribute("aria-pressed", state.semantic ? "true" : "false");
  $("search").placeholder = state.semantic ? "Ask by meaning… e.g. “cheaper AI chips”, “AI in medicine”"
    : "Search headlines, companies, tags…  ( / )";
}
function ensureEncoder() {
  if (encoder) return Promise.resolve(encoder);
  if (!encLoading) {
    encLoading = (async () => {
      setSemStatus("Loading the AI search model (about 23 MB, first time only)…");
      const [lib, emb] = await Promise.all([
        import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1"),
        fetch("embeddings.json?t=" + Date.now()).then((r) => r.json()),
      ]);
      lib.env.allowLocalModels = false;
      vecIds = emb.ids || []; dim = emb.dim || 384;
      const raw = Uint8Array.from(atob(emb.vecs || ""), (ch) => ch.charCodeAt(0));
      const q8 = new Int8Array(raw.buffer);
      vecs = new Float32Array(q8.length);
      for (let r = 0; r < vecIds.length; r++) {          // int8 -> float, re-normalize each row
        let n = 0;
        for (let k = 0; k < dim; k++) { const v = q8[r * dim + k] / 127; vecs[r * dim + k] = v; n += v * v; }
        n = Math.sqrt(n) || 1;
        for (let k = 0; k < dim; k++) vecs[r * dim + k] /= n;
      }
      encoder = await lib.pipeline("feature-extraction", emb.browser_model || "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
      setSemStatus("");
      return encoder;
    })().catch((e) => {
      console.warn("semantic search unavailable", e);
      encLoading = null; state.semantic = false; syncSem();
      setSemStatus("Couldn't load AI search right now. Using keyword search.");
      setTimeout(() => setSemStatus(""), 5000);
      throw e;
    });
  }
  return encLoading;
}
async function runSemantic(q) {
  q = q.trim();
  if (!q) { simById = new Map(); simQuery = ""; render(); return; }
  try { await ensureEncoder(); } catch { render(); return; }
  const out = await encoder(q, { pooling: "mean", normalize: true });
  const qv = out.data;
  const m = new Map();
  for (let r = 0; r < vecIds.length; r++) {
    let d = 0; const o = r * dim;
    for (let k = 0; k < dim; k++) d += vecs[o + k] * qv[k];
    m.set(vecIds[r], d);
  }
  if (state.q.trim() !== q || !state.semantic) return;   // user typed more meanwhile
  simById = m; simQuery = q; render();
}
$("semToggle").addEventListener("click", () => {
  state.semantic = !state.semantic; syncSem();
  if (state.semantic) { ensureEncoder().catch(() => {}); runSemantic(state.q); } else render();
  $("search").focus();
});


// ---------- living cards: 3D tilt toward the cursor, glare, image parallax ----------
const motionOK = !matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
if (motionOK && finePointer) {
  $("grid").addEventListener("pointermove", (e) => {
    const card = e.target.closest(".card");
    if (!card || card.classList.contains("skel")) return;
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const k = card.classList.contains("hero") ? 5 : 9;          // big cards tilt less
    card.style.setProperty("--ry", ((x - 0.5) * k).toFixed(2) + "deg");
    card.style.setProperty("--rx", (-(y - 0.5) * k).toFixed(2) + "deg");
    card.style.setProperty("--mx", (x * 100).toFixed(1) + "%");
    card.style.setProperty("--my", (y * 100).toFixed(1) + "%");
    card.style.setProperty("--px", ((0.5 - x) * 12).toFixed(1) + "px");
    card.style.setProperty("--py", ((0.5 - y) * 8).toFixed(1) + "px");
  });
  $("grid").addEventListener("pointerout", (e) => {
    const card = e.target.closest(".card");
    if (!card || card.contains(e.relatedTarget)) return;
    ["--rx", "--ry", "--px", "--py"].forEach((v) => card.style.removeProperty(v));
  });
}

// ---------- cascade in: cards rise into view as you scroll ----------
const io = motionOK && "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    }), { rootMargin: "0px 0px -30px 0px" })
  : null;
function observeCards() {
  if (!io) { $("grid").querySelectorAll(".card.pre").forEach((c) => c.classList.remove("pre")); return; }
  let k = 0;
  $("grid").querySelectorAll(".card.pre:not(.watched)").forEach((c) => {
    c.classList.add("watched");
    c.style.setProperty("--d", (k++ % 6) * 55 + "ms");
    io.observe(c);
  });
  // safety net: never leave a card invisible if the observer or animations don't run
  clearTimeout(observeCards.t);
  observeCards.t = setTimeout(() => {
    $("grid").querySelectorAll(".card.pre:not(.in)").forEach((c) => {
      const r = c.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) c.classList.remove("pre", "watched");
    });
  }, 2000);
}
$("grid").addEventListener("animationend", (e) => {
  if (e.target.classList?.contains("in")) e.target.classList.remove("pre", "in", "watched");
});

load();
