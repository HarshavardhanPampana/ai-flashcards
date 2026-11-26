"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const pct = (x) => (x == null ? "–" : Math.round(x * 100) + "%");
const getJSON = (f) => fetch(f + "?t=" + Date.now()).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const shortModel = (m) => String(m || "").split("/").pop();
const stat = (v, label) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`;
const bar = (label, v, cls = "", text) =>
  `<div class="barrow"><span>${label}</span><div class="track"><div class="fill ${cls}" style="width:${Math.round((v || 0) * 100)}%"></div></div><b>${text ?? pct(v)}</b></div>`;

async function main() {
  const [stats, images, compare, cards] = await Promise.all(
    ["stats.json", "images.json", "compare.json", "cards.json"].map(getJSON));
  const runs = stats?.runs || [];
  const nImg = Object.keys(images?.images || {}).length;

  // headline numbers
  const total = cards?.length ?? stats?.cards ?? 0;
  const sem = runs.reduce((a, r) => a + (r.semantic_removed || 0), 0);
  $("heroStats").innerHTML = [
    stat(total.toLocaleString(), "flashcards live"),
    stat(runs.length ? Math.round(runs.slice(0, 8).reduce((a, r) => a + r.collected, 0) / Math.min(8, runs.length)) : "–", "stories scanned per run"),
    stat(sem, "extra duplicates caught by meaning"),
    stat(stats?.mlp?.category ? pct(stats.mlp.category.accuracy) : "–", "MLP ↔ LLM category agreement"),
    stat(nImg, "AI-generated cover images"),
    stat("$0", "running cost"),
  ].join("");
  if (stats?.updated) $("updated").textContent = "Pipeline last ran " + new Date(stats.updated).toLocaleString();

  // model details
  const apiModels = new Set(runs.flatMap((r) => r.models || []));
  if (apiModels.size) $("apiModel").textContent = [...apiModels].map(shortModel).join(", ");
  if (stats?.mlp?.category?.params) $("mlpParams").textContent =
    `${stats.mlp.category.params.toLocaleString()} weights · scikit-learn · retrained every run on the LLM's own labels`;
  if (images?.model) $("imgModel").textContent = shortModel(images.model);
  if (images?.last_run) $("imgInfo").textContent =
    `${images.last_run.steps} denoising step · about ${images.last_run.avg_seconds}s per image on a free CPU · 448×280 WebP`;
  if (compare?.local_model) $("localModel").textContent = shortModel(compare.local_model);

  // MLP panel
  const m = stats?.mlp;
  if (m?.category) {
    const ag = stats.agreement;
    $("mlpPanel").innerHTML = `<h3>MLP vs the LLM</h3><div class="bars fnn">
      ${bar("Category, MLP", m.category.accuracy)}
      ${bar("Category, always-guess-most-common", m.category.baseline_majority, "base")}
      ${bar("Stars exactly right", m.importance.accuracy)}
      ${bar("Stars within ±1", m.importance.within_1_star)}
      </div>
      <p class="note">Held-out test on ${m.category.n_test} cards (trained on ${m.category.n_train}). The LLM's labels are the
      "answers". The MLP has ${m.category.params.toLocaleString()} weights, about <b>2 million times smaller</b> than the
      120B-parameter LLM, and predicts in microseconds, so ranking uses it to choose what's worth an LLM call.
      ${ag ? `<br>On ${ag.cards} live cards scored before the LLM saw them: category ${pct(ag.category)}, stars within ±1 ${pct(ag.importance_within_1)}.` : ""}</p>`;
  } else {
    $("mlpPanel").innerHTML = `<h3>MLP vs the LLM</h3><p class="empty-note">Appears after the next pipeline run.</p>`;
  }

  // dedupe panel
  const ex = stats?.semantic_examples || [];
  $("dedupePanel").innerHTML = `<h3>Duplicates caught by meaning</h3>
    ${ex.length ? `<ul class="dups">${ex.slice(0, 5).map((d) =>
      `<li><span class="sim">${d.similarity.toFixed(2)}</span>${esc(d.new)}<span class="vs">≈ ${esc(d.matches)}</span></li>`).join("")}</ul>`
      : `<p class="empty-note">Examples appear as the pipeline catches them.</p>`}
    <p class="note">Fuzzy title matching already catches near-identical titles. The encoder catches what it can't:
    the <b>same story from different outlets in different words</b>, like the pairs above. The 0.80 threshold was tuned
    on 131 real stories with known matches (<code>eval/dedupe_eval.py</code>): it catches 87% of true duplicates and
    flags about 2% of other stories, many of which turn out to be cross-outlet duplicates too.</p>`;

  // runs table
  $("runsPanel").innerHTML = `<h3>Recent runs</h3>${runs.length ? `<table class="runs"><thead><tr>
      <th>When</th><th>Scanned</th><th>After fuzzy</th><th>After semantic</th><th>Cards added</th><th>Seconds</th></tr></thead><tbody>
      ${runs.slice(0, 10).map((r) => `<tr><td>${new Date(r.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        <td>${r.collected}</td><td>${r.after_fuzzy}</td><td>${r.after_semantic}</td><td>${r.cards_added}</td><td>${r.seconds}</td></tr>`).join("")}
      </tbody></table>` : `<p class="empty-note">The table fills in after the next pipeline run.</p>`}`;

  // decoder comparison
  const items = compare?.items || [];
  const sm = compare?.summary;
  if (!items.length) {
    $("compareItems").innerHTML = `<p class="empty-note">The weekly comparison hasn't run yet.</p>`;
    return;
  }
  $("compareSummary").innerHTML = [
    stat(pct(sm.json_valid_rate), "valid card JSON (local model)"),
    stat(sm.avg_seconds_local + "s", `per card on CPU (${sm.avg_tokens_per_second} tokens/s)`),
    stat(pct(sm.category_agreement), "same category as the 120B model"),
    stat(sm.avg_tldr_similarity == null ? "–" : sm.avg_tldr_similarity.toFixed(2), "TL;DR meaning similarity (encoder)"),
  ].join("");
  const side = (who, cls, c, meta, bad) => `<div class="side ${cls}"><span class="who">${who}</span>
    ${bad ? `<p class="bad">Didn't return valid card JSON</p><p class="meta2">${esc(bad)}</p>` : `
    <h4>${esc(c.headline)}</h4><p>${esc(c.tldr)}</p>
    ${(c.key_points || []).length ? `<ul>${c.key_points.slice(0, 4).map((k) => `<li>${esc(k)}</li>`).join("")}</ul>` : ""}`}
    <p class="meta2">${meta}</p></div>`;
  $("compareItems").innerHTML = items.slice(0, 6).map((x) => `<div class="cmp">
      <div class="cmp-head">${esc(x.title)} <a href="${/^https?:/.test(x.url) ? esc(x.url) : "#"}" target="_blank" rel="noopener">source ↗</a></div>
      ${side("API · " + esc(shortModel(x.api.model) || compare.api_model), "llm", x.api,
        `★${x.api.importance} · ${esc(x.api.category)}`)}
      ${side("Local · " + esc(shortModel(compare.local_model)), "dec", x.local.card,
        `★${x.local.card.importance} · ${esc(x.local.card.category)} · ${x.local.seconds}s on CPU` +
        (x.tldr_similarity != null ? ` · similarity ${x.tldr_similarity.toFixed(2)}` : ""),
        x.local.valid_json ? "" : (x.local.raw || "").slice(0, 160))}
    </div>`).join("");
}
main();

// ---------- palette: exact Sanzo Wada colours used on the site ----------
(function swatches() {
  const P = [
    ["Model release", "Deep Lyons Blue", "#1c4286", "Pale King's Blue 2", "#a7d4e4"],
    ["Paper", "Violet", "#4f4086", "Grayish Lavender 1", "#b5b1d8"],
    ["Product", "Vandar Poel's Blue", "#064f6e", "Calamine Blue", "#78cdd0"],
    ["Funding", "Lincoln Green", "#555832", "Light Green Yellow", "#c7d14f"],
    ["Acquisition", "Brick Red", "#a84222", "Pinkish Cinnamon", "#eeb480"],
    ["Policy", "Carmine Red", "#a62c37", "Corinthian Pink", "#f8b6ba"],
    ["Hardware", "Pale Raw Umber", "#71502f", "Yellow Ocher", "#e2b540"],
    ["Open source", "Dusky Green", "#004f46", "Cobalt Green", "#96d1aa"],
    ["Other", "Slate Color", "#34454c", "Neutral Gray", "#b6bfc1"],
    ["Paper / night", "Ivory Buff", "#ebd3a2", "Deep Slate Green", "#112f2c"],
    ["Ink / text", "Black", "#111314", "Naples Yellow", "#fbe6a0"],
    ["Accent", "Deep Lyons Blue", "#1c4286", "Coral Red", "#f58e84"],
  ];
  const el = document.getElementById("swatches");
  if (!el) return;
  const dark = () => document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const draw = () => {
    const d = dark();
    el.innerHTML = P.map(([role, ln, lh, dn, dh]) => {
      const [n, h] = d ? [dn, dh] : [ln, lh];
      return `<div class="sw"><span class="chip-c" style="background:${h}"></span><b>${esc(n)}</b><span>${h} · ${esc(role)}</span></div>`;
    }).join("");
  };
  draw();
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", draw);
})();
