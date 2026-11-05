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
const state = { cat: "", time: "all", q: "", minImp: 1, review: "", sort: "top" };
Object.assign(state, store.get("filters", {}), { q: "" });

// "New since last visit": a visit = a session separated by 30+ minutes
const now = Date.now();
const visits = store.get("visits", { current: 0, previous: 0 });
if (now - visits.current > 30 * 60 * 1000) { visits.previous = visits.current; visits.current = now; }
store.set("visits", visits);
const lastVisit = visits.previous;

let cards = [];
let view = [];

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
const isNew = (c) => lastVisit && ts(c.added) > lastVisit;
const stars = (n) => { n = Math.max(1, Math.min(5, n || 1)); return "★".repeat(n) + `<span class="off">${"★".repeat(5 - n)}</span>`; };

// ---------- load ----------
async function load() {
  $("grid").innerHTML = Array.from({ length: 6 }, () =>
    `<div class="card skel"><div class="inner"><div class="face"></div></div></div>`).join("");
  try {
    const res = await fetch("cards.json?t=" + Date.now()); // bypass cache
    cards = await res.json();
  } catch {
    $("grid").innerHTML = `<div class="empty"><b>Couldn't load cards.json</b>Serve this folder over http (not file://).</div>`;
    $("updated").textContent = "";
    return;
  }
  cards.forEach((c) => { c._cat = catKey(c.category); c._text = JSON.stringify(c).toLowerCase(); });
  const latest = Math.max(0, ...cards.map((c) => ts(c.added)));
  const fresh = cards.filter(isNew).length;
  $("updated").textContent = latest
    ? `Updated ${ago(new Date(latest).toISOString())} · refreshes every 6 hours` + (fresh ? ` · ${fresh} new for you` : "")
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
    .filter((c) => !q || q.split(/\s+/).every((w) => c._text.includes(w)))
    .sort((a, b) => state.sort === "new"
      ? ts(b.added) - ts(a.added) || ts(b.date) - ts(a.date)
      : (b.importance || 1) - (a.importance || 1) || ts(b.added) - ts(a.added));
}

function cardHTML(c) {
  const st = progress[c.id];
  return `
  <div class="card ${st ? "st-" + st : ""}" data-id="${esc(c.id)}" style="--c:var(--c-${c._cat})"
       tabindex="0" role="button" aria-label="${esc(c.headline)}. Press Enter to flip.">
    <span class="badge-state" aria-hidden="true">${st === "got" ? "✓" : st === "again" ? "↻" : ""}</span>
    <div class="inner">
      <div class="face front">
        <div class="meta">
          <span class="cat">${esc(catName(c._cat))}</span>
          ${isNew(c) ? `<span class="new">NEW</span>` : ""}
          ${picks[c.id] === "keep" ? `<span class="picked-heart" title="In your picks">♥</span>` : ""}
          <span class="stars" title="Importance ${c.importance || 1}/5">${stars(c.importance)}</span>
        </div>
        <h3>${esc(c.headline)}</h3>
        <p class="tldr">${esc(c.tldr)}</p>
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

function render() {
  view = filtered();
  $("count").textContent = cards.length ? `Showing ${view.length} of ${cards.length} cards` : "";
  $("grid").innerHTML = view.length ? view.map(cardHTML).join("") : emptyHTML();
  updateProgress();
  store.set("filters", { cat: state.cat, time: state.time, minImp: state.minImp, review: state.review, sort: state.sort });
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
  const card = e.target.closest(".card");
  if (!card || card.classList.contains("skel") || e.target.closest("a")) return;
  const btn = e.target.closest("button[data-mark]");
  if (btn) {
    applyMarkClass(card, mark(card.dataset.id, btn.dataset.mark));
    if (state.review) setTimeout(render, 250);   // card may no longer match the status filter
    return;
  }
  card.classList.toggle("flipped");
});
$("grid").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("card")) {
    e.preventDefault(); e.target.classList.toggle("flipped");
  }
});

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
  searchTimer = setTimeout(() => { state.q = e.target.value; render(); }, 120);
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
function openStudy() {
  // unreviewed and "review again" cards first, "got it" last
  const rank = (c) => (progress[c.id] === "got" ? 2 : progress[c.id] === "again" ? 0 : 1);
  deck = filtered().slice().sort((a, b) => rank(a) - rank(b));
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
$("study").addEventListener("click", openStudy);
$("studyClose").addEventListener("click", closeStudy);
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
$("got").addEventListener("click", () => studyMark("got"));
$("again").addEventListener("click", () => studyMark("again"));
$("studyStage").addEventListener("click", (e) => {
  const card = e.target.closest(".card"); if (!card || e.target.closest("a")) return;
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

load();
