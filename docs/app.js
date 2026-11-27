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
  buildMasthead();
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
        ${c._img ? `<div class="thumb"><img src="${esc(c._img)}" alt="AI-generated illustration" loading="lazy" decoding="async"><span class="ai-badge" title="Illustration made by SD-Turbo, not a photo of the real event">AI-generated image</span></div>` : ""}
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
  const tile = document.querySelector("#mhStats .mh-stat:last-child b");   // masthead "learned" tile
  if (tile) tile.textContent = got;
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
  const dark = root.dataset.theme !== "light";          // dark is the default look
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
    else if (e.key === "1") studyMark("again");   // keys follow the buttons, left to right
    else if (e.key === "2") studyMark("got");
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


// ---------- masthead, live ticker, stats and trending topics ----------
function buildMasthead() {
  const DAY = 86400e3, nowT = Date.now();
  const today = cards.filter((c) => nowT - ts(c.added) < DAY);
  const recent = today.length ? today : cards.slice(0, 40);
  const week = cards.filter((c) => nowT - ts(c.added) < 7 * DAY);
  const sources = new Set(recent.map((c) => c.source));
  const latest = Math.max(0, ...cards.map((c) => ts(c.added)));
  $("mhKicker").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
    + (latest ? " · updated " + ago(new Date(latest).toISOString()) : "");
  const top = recent.slice().sort((a, b) => (b.importance || 1) - (a.importance || 1))[0];
  $("mhSub").innerHTML = cards.length
    ? `<b>${recent.length}</b> new ${today.length ? "stories in the last 24 hours" : "stories"} from <b>${sources.size}</b> sources.`
      + (top ? ` Today's top story: <a href="#" data-open="${esc(top.id)}">${esc(top.headline)}</a>` : "")
    : "No stories yet. The pipeline runs a couple of times a day.";

  // stats
  const catCount = {};
  recent.forEach((c) => { catCount[c._cat] = (catCount[c._cat] || 0) + 1; });
  const topCat = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0];
  const learned = cards.filter((c) => progress[c.id] === "got").length;
  const stat = (n, label, cls = "", style = "") => `<div class="mh-stat ${cls}" style="${style}"><b>${n}</b><span>${label}</span></div>`;
  $("mhStats").innerHTML = [
    stat(today.length, "new today", "hot"),
    stat(new Set(week.map((c) => c.source)).size, "sources this week"),
    topCat ? stat(esc(catName(topCat[0])), "top topic today", "topic", `--c:var(--c-${topCat[0]})`) : "",
    stat(learned, "cards you've learned"),
  ].join("");

  // ticker: newest headlines, duplicated so the loop is seamless
  const newest = cards.slice().sort((a, b) => ts(b.added) - ts(a.added) || (b.importance || 1) - (a.importance || 1)).slice(0, 16);
  const items = newest.map((c) => `<button type="button" class="tick" data-open="${esc(c.id)}" style="--c:var(--c-${c._cat})">
    <span class="dot"></span>${esc(c.headline)}</button>`).join("");
  $("ticker").innerHTML = items + `<span aria-hidden="true" class="tick-dup">${items}</span>`;
  $("ticker").style.setProperty("--dur", Math.max(40, newest.length * 7) + "s");
  $("tickerWrap").hidden = !newest.length;

  // trending tags (last 48 h, or the last week if it's quiet)
  const pool = cards.filter((c) => nowT - ts(c.added) < 2 * DAY);
  const tagCount = {};
  (pool.length >= 20 ? pool : week).forEach((c) => (c.tags || []).forEach((t) => {
    const k = String(t).trim().toLowerCase(); if (k.length > 1) tagCount[k] = (tagCount[k] || 0) + 1;
  }));
  const tags = Object.entries(tagCount).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 12);
  $("trending").innerHTML = tags.length
    ? `<span class="t-label">Trending</span>` + tags.map(([t, n], i) =>
        `<button type="button" class="t-chip" data-tag="${esc(t)}" style="--i:${i}">#${esc(t)} <span>${n}</span></button>`).join("")
    : "";
}
// clicks in the masthead / ticker open that card; trending chips search for the tag
document.addEventListener("click", (e) => {
  const open = e.target.closest("[data-open]");
  if (open && !open.closest(".card")) {
    e.preventDefault();
    const c = byId.get(open.dataset.open);
    if (c) openStudy([c, ...(c.related || []).map((id) => byId.get(id)).filter(Boolean)]);
    return;
  }
  const tag = e.target.closest("[data-tag]");
  if (tag) {
    const q = state.q.trim().toLowerCase() === tag.dataset.tag ? "" : tag.dataset.tag;
    state.q = q; $("search").value = q;
    document.querySelectorAll(".t-chip").forEach((b) => b.classList.toggle("on", b.dataset.tag === q && !!q));
    if (state.semantic && q) runSemantic(q); else render();
    if (q) $("count").scrollIntoView({ behavior: "smooth", block: "start" });
  }
});


// ---------- scroll wheel: a canvas-drawn silver thumbwheel with hair-thin ridges ----------
// Drawn at full screen resolution with per-ridge lighting, so it reads as polished aluminium.
// Position, roll, zoom and fade are all eased every frame (transform + opacity only, no layout).
// Each ridge passing the centre gives a small visual pulse (and a tiny vibration on Android phones).
(function scrollWheel() {
  const wheel = $("scrollKnob"), canvas = wheel.querySelector("canvas"), g = canvas.getContext("2d");
  const coarse = matchMedia("(pointer: coarse)").matches;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canBuzz = "vibrate" in navigator && coarse;
  const W = 20, H = 76, PAD = 10;          // css px; keep in sync with .wheel
  const RIDGES = 72;                       // fine ridges all the way round (fewer = less shimmer when moving)
  const DEG_PER_PX = 0.30;                 // roll speed
  const DETENT_DEG = 15;                   // a click every 15 degrees (~50px of scrolling)

  // ---- canvas at device resolution ----
  let dpr = 1;
  function sizeCanvas() {
    dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
  }
  sizeCanvas();
  const isLight = () => document.documentElement.dataset.theme === "light";

  // ---- draw one frame of the wheel at rotation `deg` ----
  function draw(deg) {
    const w = canvas.width, h = canvas.height, R = h / 2, cx = w / 2;
    const light = isLight();
    g.clearRect(0, 0, w, h);
    g.save();
    // rounded body clip (a cylinder seen edge-on)
    const rad = Math.min(w / 2, 9 * dpr);
    g.beginPath(); g.roundRect ? g.roundRect(0, 0, w, h, rad) : g.rect(0, 0, w, h); g.clip();

    // base metal: vertical curvature light (bright just above centre, falling off to the rims)
    const base = g.createLinearGradient(0, 0, 0, h);
    const stops = light
      ? [[0, "#7d8488"], [.18, "#a2a9ad"], [.40, "#d3d9dd"], [.5, "#bfc5ca"], [.72, "#9aa0a5"], [1, "#767c81"]]   // soft brushed silver
      : [[0, "#101215"], [.18, "#33373d"], [.40, "#7a8089"], [.5, "#5b6068"], [.72, "#30343a"], [1, "#0e1013"]];  // gunmetal
    stops.forEach(([o, c]) => base.addColorStop(o, c));
    g.fillStyle = base; g.fillRect(0, 0, w, h);

    // hair-thin ridges: project each ridge around the cylinder, foreshorten and light it
    const step = 360 / RIDGES;
    const off = ((deg % step) + step) % step;
    for (let k = -RIDGES / 2; k <= RIDGES / 2; k++) {
      const a = (k * step + off) * Math.PI / 180;           // angle from the viewer
      const c = Math.cos(a);
      if (c <= 0.02) continue;
      const y = R + Math.sin(a) * R * 0.985;
      const t = Math.max(0.45, c) * dpr * 1.25;             // thickness shrinks towards the rims
      const lit = 0.55 + 0.45 * Math.cos(a + 0.35);         // light from slightly above
      g.fillStyle = `rgba(0,0,0,${(light ? 0.28 : 0.42) * (0.55 + 0.45 * c)})`;   // groove
      g.fillRect(0, y - t * 0.55, w, t * 0.55);
      g.fillStyle = `rgba(255,255,255,${(light ? 0.34 : 0.26) * lit * c})`;        // ridge crest
      g.fillRect(0, y, w, t * 0.45);
    }


    // soft specular sheen + side bevels so it reads as a solid metal disc edge
    const sheen = g.createLinearGradient(0, 0, 0, h);
    sheen.addColorStop(.30, "rgba(255,255,255,0)");
    sheen.addColorStop(.42, `rgba(255,255,255,${light ? .35 : .22})`);
    sheen.addColorStop(.52, "rgba(255,255,255,0)");
    g.fillStyle = sheen; g.fillRect(0, 0, w, h);
    const bevel = g.createLinearGradient(0, 0, w, 0);
    bevel.addColorStop(0, "rgba(0,0,0,.45)"); bevel.addColorStop(.16, "rgba(0,0,0,0)");
    bevel.addColorStop(.84, "rgba(0,0,0,0)"); bevel.addColorStop(1, "rgba(0,0,0,.45)");
    g.fillStyle = bevel; g.fillRect(0, 0, w, h);
    const rim = g.createLinearGradient(0, 0, 0, h);                // rims fall into shadow
    rim.addColorStop(0, "rgba(0,0,0,.55)"); rim.addColorStop(.12, "rgba(0,0,0,0)");
    rim.addColorStop(.88, "rgba(0,0,0,0)"); rim.addColorStop(1, "rgba(0,0,0,.55)");
    g.fillStyle = rim; g.fillRect(0, 0, w, h);
    g.restore();
  }

  // ---- motion: eased every frame ----
  // page metrics are cached and refreshed only when the page size changes, so scrolling never forces layout
  let docH = 0, viewH = innerHeight;
  const measure = () => { docH = document.documentElement.scrollHeight; viewH = innerHeight; };
  measure();
  if ("ResizeObserver" in window) new ResizeObserver(() => { measure(); targets(); kick(); }).observe(document.body);
  const maxScroll = () => Math.max(1, docH - viewH);
  let tY = 0, tA = 0, tZ = 0, y = 0, a = 0, z = 0;        // z: 0 = resting, 1 = active
  let lastFrame = 0, running = false, lastDetent = null, lastClick = 0, hideT = 0, dragging = false, safety = 0;
  function targets() {
    const scrollable = docH - viewH > 200;
    if (wheel.hidden === scrollable) wheel.hidden = !scrollable;
    const pr = Math.min(1, Math.max(0, scrollY / maxScroll()));
    tY = PAD + pr * (viewH - H - 2 * PAD);
    tA = scrollY * DEG_PER_PX;
    wheel.setAttribute("aria-valuenow", Math.round(pr * 100));
    return scrollable;
  }
  let drawnA = NaN, pulse = 0, vz = 0, scrolling = false, scrollEnd = 0;
  function render() {
    const scale = 0.6 + 0.2 * z + 0.015 * pulse;   // 60% at rest, 80% while scrolling, plus a tiny notch pulse
    const snapY = Math.round(y * dpr) / dpr;                 // land on real pixels: no sub-pixel jitter
    wheel.style.transform = `translate3d(0, ${snapY}px, 0) scale(${scale.toFixed(3)})`;
    wheel.style.opacity = ((isLight() ? 0.85 : 0.55) + (isLight() ? 0.15 : 0.45) * z).toFixed(3);   // light: same silver at rest and in motion
    if (!(Math.abs(a - drawnA) <= 0.04) || pulse > 0.02) { draw(a); drawnA = a; }   // (also true when drawnA is NaN)
    const d = Math.floor(a / DETENT_DEG);
    if (lastDetent !== null && d !== lastDetent) {
      const now = performance.now();
      if (now - lastClick > 60) {                                 // at most ~16 notches a second
        lastClick = now;
        pulse = 1;                                                  // the wheel "seats" into the notch
        if (canBuzz) { try { navigator.vibrate(4); } catch {} }
      }
    }
    lastDetent = d;
  }
  function frame() {
    const now = performance.now();
    const dt = Math.min(64, Math.max(0, now - (lastFrame || now - 16))); lastFrame = now;
    // position and roll follow the page exactly, sampled once per frame. The browser already animates
    // its own smooth scrolling, so the wheel moves in lock-step with it: no lag, no catch-up, no steps.
    targets(); y = tY; a = tA;
    if (reduced) { z = tZ; vz = 0; pulse = 0; }
    else {
      // zoom rides a soft spring (slightly under-damped) so it settles with a gentle, physical overshoot
      const s = dt / 1000, w = 20, zeta = 0.72;
      for (let n = 0; n < 2; n++) { vz += (w * w * (tZ - z) - 2 * zeta * w * vz) * (s / 2); z += vz * (s / 2); }
      pulse *= Math.exp(-dt / 70);
    }
    render();
    if (scrolling || Math.abs(tZ - z) > 0.002 || Math.abs(vz) > 0.01 || pulse > 0.01)
      requestAnimationFrame(frame);
    else { z = tZ; vz = 0; pulse = 0; render(); running = false; }
  }
  function kick() {
    if (!running) { running = true; lastFrame = 0; requestAnimationFrame(frame); }
    clearTimeout(safety);                // background tab with no animation frames: snap into place
    safety = setTimeout(() => {
      if (running && performance.now() - lastFrame > 140) { y = tY; a = tA; z = tZ; vz = 0; pulse = 0; render(); running = false; }
    }, 150);
  }
  function wake() {
    tZ = 1;
    clearTimeout(hideT);
    if (!dragging) hideT = setTimeout(() => { tZ = 0; kick(); }, 1000);
  }
  addEventListener("scroll", () => {
    if (!targets()) return;
    scrolling = true; clearTimeout(scrollEnd);
    scrollEnd = setTimeout(() => { scrolling = false; }, 120);   // keep sampling until the page settles
    wake(); kick();
  }, { passive: true });
  addEventListener("resize", () => { sizeCanvas(); drawnA = NaN; measure(); targets(); kick(); });
  new MutationObserver(() => { measure(); targets(); kick(); }).observe($("grid"), { childList: true });
  new MutationObserver(() => { drawnA = NaN; render(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ---- drag along the scrollbar line ----
  function dragTo(clientY) {
    const pr = Math.min(1, Math.max(0, (clientY - PAD - H / 2) / (innerHeight - H - 2 * PAD)));
    scrollTo({ top: pr * maxScroll(), behavior: "auto" });
    targets(); kick();
  }
  wheel.addEventListener("pointerdown", (e) => {
    dragging = true; wake();
    try { wheel.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  wheel.addEventListener("pointermove", (e) => { if (dragging) dragTo(e.clientY); });
  const end = () => { if (!dragging) return; dragging = false; wake(); kick(); };
  wheel.addEventListener("pointerup", end);
  wheel.addEventListener("pointercancel", end);

  targets(); y = tY; a = tA; z = 0; render();
})();

load();
