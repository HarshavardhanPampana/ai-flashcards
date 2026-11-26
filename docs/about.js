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

  // decoder comparison (accepts the old single-model format too)
  let items = compare?.items || [];
  let models = compare?.local_models || (compare?.local_model ? [compare.local_model] : []);
  let summary = compare?.summary || {};
  if (compare?.local_model && !compare.local_models) {           // old format
    items = items.map((x) => ({ ...x, locals: x.locals || { [compare.local_model]: { ...x.local, tldr_similarity: x.tldr_similarity } } }));
    summary = { [compare.local_model]: { n: items.length, json_valid_rate: summary.json_valid_rate, avg_seconds: summary.avg_seconds_local,
      avg_tokens_per_second: summary.avg_tokens_per_second, category_agreement: summary.category_agreement,
      importance_within_1: summary.importance_within_1, avg_tldr_similarity: summary.avg_tldr_similarity } };
  }
  if (!items.length || !models.length) {
    $("compareItems").innerHTML = `<p class="empty-note">The weekly comparison hasn't run yet.</p>`;
    return;
  }
  if (models.length) $("localModel").textContent = models.map(shortModel).join(" + ");
  const size = (m) => { const x = /(\d+(?:\.\d+)?)B/i.exec(m); return x ? x[1] + "B" : shortModel(m); };
  const ci = (c) => (c ? ` <span class="ci">${Math.round(c[0] * 100)}–${Math.round(c[1] * 100)}%</span>` : "");
  const cell = (v, c) => (v == null ? "–" : pct(v) + ci(c));
  const nStories = Math.max(...models.map((m) => summary[m]?.n || 0));
  $("compareSummary").outerHTML = `<div class="panel wide" id="compareSummary">
    <h3>Results by model <span class="muted" style="font-weight:400;font-size:13px">· ${nStories} stories so far, growing every week</span></h3>
    <table class="runs cmp-table"><thead><tr><th>Model</th><th>Stories</th><th>Valid card JSON</th><th>Same category as 120B</th>
      <th>Stars within ±1</th><th>TL;DR similarity</th><th>Speed (CPU)</th></tr></thead><tbody>
    ${models.map((m) => { const s = summary[m] || {}; return `<tr>
      <td><b>${esc(shortModel(m))}</b></td><td>${s.n ?? 0}</td>
      <td>${cell(s.json_valid_rate, s.json_valid_ci)}</td><td>${cell(s.category_agreement, s.category_ci)}</td>
      <td>${cell(s.importance_within_1, s.importance_ci)}</td>
      <td>${s.avg_tldr_similarity == null ? "–" : s.avg_tldr_similarity.toFixed(2)}</td>
      <td>${s.avg_seconds ?? "–"}s · ${s.avg_tokens_per_second ?? "–"} tok/s</td></tr>`; }).join("")}
    <tr class="ref"><td><b>${esc(shortModel(compare.api_model))}</b> (reference)</td><td>–</td><td>100%</td><td>–</td><td>–</td><td>1.00</td><td>API</td></tr>
    </tbody></table>
    <p class="note">Small grey ranges are 95% confidence intervals: with only a few stories they're wide, and they
      narrow as the weekly runs add more. Agreement is measured only on cards where the local model returned valid JSON.</p></div>`;

  const side = (who, cls, c, meta, bad) => `<div class="side ${cls}"><span class="who">${who}</span>
    ${bad != null ? `<p class="bad">Didn't return valid card JSON</p><p class="meta2">${esc(bad)}</p>` : `
    <h4>${esc(c.headline)}</h4><p>${esc(c.tldr)}</p>
    ${(c.key_points || []).length ? `<ul>${c.key_points.slice(0, 4).map((k) => `<li>${esc(k)}</li>`).join("")}</ul>` : ""}`}
    <p class="meta2">${meta}</p></div>`;
  const shown = items.filter((x) => models.some((m) => x.locals[m])).slice(0, 6);
  $("compareItems").innerHTML = shown.map((x) => `<div class="cmp" style="--cols:${1 + models.length}">
      <div class="cmp-head">${esc(x.title)} <a href="${/^https?:/.test(x.url) ? esc(x.url) : "#"}" target="_blank" rel="noopener">source ↗</a></div>
      ${side("API · " + esc(shortModel(x.api.model) || shortModel(compare.api_model)), "llm", x.api,
        `★${x.api.importance} · ${esc(x.api.category)}`)}
      ${models.map((m, k) => { const l = x.locals[m];
        if (!l) return `<div class="side dec${k ? " dec2" : ""}"><span class="who">Local · ${esc(size(m))}</span><p class="meta2">Not run on this story yet</p></div>`;
        return side("Local · " + esc(shortModel(m)), "dec" + (k ? " dec2" : ""), l.card,
          `★${l.card.importance} · ${esc(l.card.category)} · ${l.seconds}s on CPU` +
          (l.tldr_similarity != null ? ` · similarity ${l.tldr_similarity.toFixed(2)}` : ""),
          l.valid_json ? null : (l.raw || "").slice(0, 160)); }).join("")}
    </div>`).join("");
}
main();

// ---------- palette: exact Sanzo Wada colours used on the site ----------
(function swatches() {
  const P = [   // [role, light name, light hex, dark name, dark hex]
    ["Model release", "Blue", "#006eb8", "Yellow", "#fff200"],
    ["Paper", "Violet", "#4f4086", "Lilac", "#b984af"],
    ["Product", "Antwarp Blue", "#007190", "Calamine Blue", "#78cdd0"],
    ["Funding", "Cossack Green", "#437742", "Light Green", "#87c540"],
    ["Acquisition", "Rosolanc Purple", "#b73f74", "Yellow Orange", "#f99d1b"],
    ["Policy", "Carmine", "#cc1236", "Peach Red", "#f15a30"],
    ["Hardware", "Brick Red", "#a84222", "Eosine Pink", "#f37f94"],
    ["Open source", "Dusky Green", "#004f46", "Sea Green", "#00b49b"],
    ["Other", "Slate Color", "#34454c", "Neutral Gray", "#b6bfc1"],
    ["Accent", "Carmine", "#cc1236", "Peach Red", "#f15a30"],
    ["Ink / NEW", "Black", "#111314", "Yellow", "#fff200"],
  ];
  const el = document.getElementById("swatches");
  if (!el) return;
  const dark = () => document.documentElement.dataset.theme !== "light";   // dark is the default
  const draw = () => {
    const d = dark();
    el.innerHTML = P.map(([role, ln, lh, dn, dh]) => {
      const [n, h] = d ? [dn, dh] : [ln, lh];
      return `<div class="sw"><span class="chip-c" style="background:${h}"></span><b>${esc(n)}</b><span>${h} · ${esc(role)}</span></div>`;
    }).join("");
  };
  draw();
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
