let cards = [];
const $ = (id) => document.getElementById(id);

// Spaced-repetition-lite: per-browser "Got it" / "Review again" state in localStorage
let progress = {};
try { progress = JSON.parse(localStorage.getItem("progress") || "{}"); } catch { progress = {}; }
function saveProgress() {
  try { localStorage.setItem("progress", JSON.stringify(progress)); } catch {}
}

async function load() {
  try {
    const res = await fetch("cards.json?t=" + Date.now()); // bypass cache
    cards = await res.json();
  } catch (e) {
    $("count").textContent = "Could not load cards.json (serve this folder over http, not file://).";
    return;
  }
  const cats = [...new Set(cards.map(c => c.category))].sort();
  cats.forEach(c => $("category").add(new Option(c.replace("_", " "), c)));
  render();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function safeUrl(u) {
  return /^https?:\/\//i.test(u || "") ? u : "#";
}

function fmtDate(d) {
  const t = Date.parse(d);
  return isNaN(t) ? (d || "").slice(0, 16) : new Date(t).toLocaleDateString(undefined,
    { year: "numeric", month: "short", day: "numeric" });
}

function render() {
  const q = $("search").value.toLowerCase();
  const cat = $("category").value;
  const minImp = +$("importance").value;
  const rev = $("review").value;
  const list = cards
    .filter(c => (!cat || c.category === cat) && (c.importance || 1) >= minImp)
    .filter(c => !rev || (rev === "todo" ? !progress[c.id] : progress[c.id] === rev))
    .filter(c => !q || JSON.stringify(c).toLowerCase().includes(q))
    .sort((a, b) => (b.importance || 1) - (a.importance || 1) ||
                    (b.added || "").localeCompare(a.added || ""));
  $("count").textContent = cards.length
    ? `${list.length} of ${cards.length} cards`
    : "No cards yet - run the scraper (python -m scraper.main).";
  $("grid").innerHTML = list.map(c => `
    <div class="card ${progress[c.id] ? "st-" + progress[c.id] : ""}" data-id="${esc(c.id)}" tabindex="0" role="button" aria-label="Flip card">
      <div class="inner">
        <div class="front">
          <div class="meta">
            <span class="badge">${esc((c.category || "other").replace("_", " "))}</span>
            <span class="imp" title="importance ${c.importance || 1}/5">${"★".repeat(c.importance || 1)}${"☆".repeat(5 - (c.importance || 1))}</span>
          </div>
          <h3>${esc(c.headline)}</h3>
          <p>${esc(c.tldr)}</p>
          <div class="tags">${(c.tags || []).map(t => `<span>${esc(t)}</span>`).join("")}</div>
          <small>${esc(c.source)} · ${esc(fmtDate(c.date))}</small>
        </div>
        <div class="back">
          ${(c.key_points || []).length ? `<ul>${c.key_points.map(k => `<li>${esc(k)}</li>`).join("")}</ul>` : ""}
          <p><b>Why it matters:</b> ${esc(c.why_it_matters)}</p>
          <div class="actions">
            <a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener">Read source</a>
            <span class="sr">
              <button data-mark="got">Got it</button>
              <button data-mark="again">Review again</button>
            </span>
          </div>
        </div>
      </div>
    </div>`).join("");
}

$("grid").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  if (e.target.closest("a")) return;
  const btn = e.target.closest("button[data-mark]");
  if (btn) {
    const id = card.dataset.id, mark = btn.dataset.mark;
    progress[id] = progress[id] === mark ? undefined : mark;
    if (!progress[id]) delete progress[id];
    saveProgress();
    card.classList.remove("st-got", "st-again");
    if (progress[id]) card.classList.add("st-" + progress[id]);
    return;
  }
  card.classList.toggle("flipped");
});
$("grid").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("card")) {
    e.preventDefault();
    e.target.classList.toggle("flipped");
  }
});

["search", "category", "importance", "review"].forEach(id => $(id).addEventListener("input", render));
load();
