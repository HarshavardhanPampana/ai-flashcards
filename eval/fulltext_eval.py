"""Large test of full-article fetching and the key-point fact check, on every card in git history.

run: python -m eval.fulltext_eval            (downloads are cached in .cache/fulltext, so re-runs are fast)

1. Collects every unique LLM-written card from all past versions of docs/cards.json.
2. Fetches each story's page politely (robots.txt, one request at a time per site, slower for arXiv)
   and extracts the main text with the same function the pipeline uses.
3. For every key point it measures the similarity to the closest sentence of:
     - its own article                         (should be supported)
     - the article of the most similar OTHER card (hard control: same topic, different story)
     - a random other article                  (easy control)
4. Sweeps thresholds and reports how many real points would be kept and how many control points rejected.
Writes eval/results/fulltext_eval.json and eval/results/fulltext_eval.md.
"""
import hashlib
import json
import random
import subprocess
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import numpy as np

from scraper import embed as E
from scraper import fetchers as F
from scraper import semantic as S

CACHE = Path(".cache/fulltext")
OUT = Path("eval/results")
SLOW = {"arxiv.org": 3.0, "export.arxiv.org": 3.0}   # arXiv asks automated clients to go slowly
DEFAULT_DELAY = 1.0
MIN_TEXT = 300                                       # same rule as the pipeline: too little text = skip


def history_cards():
    revs = subprocess.run(["git", "rev-list", "HEAD", "--", "docs/cards.json"],
                          capture_output=True, text=True).stdout.split()
    cards = {}
    for r in revs:
        out = subprocess.run(["git", "show", f"{r}:docs/cards.json"], capture_output=True,
                             text=True, encoding="utf-8").stdout
        try:
            for c in json.loads(out):
                if c.get("url") and c.get("key_points") and not c.get("no_llm"):
                    cards.setdefault(c["id"], c)
        except json.JSONDecodeError:
            continue
    return list(cards.values()), len(revs)


_locks, _last = defaultdict(threading.Lock), defaultdict(float)


def fetch_cached(url):
    key = CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".json")
    if key.exists():
        return json.loads(key.read_text(encoding="utf-8"))
    host = urlparse(url).netloc
    if host == "huggingface.co" and "/papers/" in url:
        host = "arxiv.org"                          # these are read from arXiv, so pace them like arXiv
    with _locks[host]:                                 # one request at a time per site, with a delay
        wait = SLOW.get(host, DEFAULT_DELAY) - (time.time() - _last[host])
        if wait > 0:
            time.sleep(wait)
        try:
            if not F.allowed_by_robots(url):
                res = {"status": "robots", "text": ""}
            else:
                t = F.fetch_article_text(url)
                res = {"status": "ok" if len(t) >= MIN_TEXT else "short", "text": t}
        except Exception as e:
            res = {"status": "error", "text": "", "err": type(e).__name__}
        _last[host] = time.time()
    key.write_text(json.dumps(res), encoding="utf-8")
    return res


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    cards, n_revs = history_cards()
    print(f"{len(cards)} unique cards from {n_revs} versions of cards.json")

    # fetch: different sites in parallel, each site politely one at a time
    by_host = defaultdict(list)
    for c in cards:
        by_host[urlparse(c["url"]).netloc].append(c)
    results = {}

    def run_host(host_cards):
        for c in host_cards:
            results[c["id"]] = fetch_cached(c["url"])
    with ThreadPoolExecutor(max_workers=12) as ex:
        list(ex.map(run_host, by_host.values()))
    print(f"fetched in {time.time() - t0:.0f}s")

    # fetch stats per site
    per_site = {}
    for host, cs in sorted(by_host.items(), key=lambda kv: -len(kv[1])):
        st = Counter(results[c["id"]]["status"] for c in cs)
        lens = [len(results[c["id"]]["text"]) for c in cs if results[c["id"]]["status"] == "ok"]
        per_site[host] = {"cards": len(cs), **st, "median_chars": int(np.median(lens)) if lens else 0}
    ok_cards = [c for c in cards if results[c["id"]]["status"] == "ok"]
    print(f"full text for {len(ok_cards)} of {len(cards)} cards")

    # grounding: own article vs hard control (most similar other card) vs random control
    sents = {c["id"]: S.split_sentences(results[c["id"]]["text"]) for c in ok_cards}
    sent_vecs = {cid: E.embed(s) for cid, s in sents.items()}
    card_vecs = E.embed([c["headline"] + ". " + c.get("tldr", "") for c in ok_cards])
    sim = card_vecs @ card_vecs.T
    np.fill_diagonal(sim, -1)
    rng = random.Random(0)
    own, hard, rand = [], [], []
    for i, c in enumerate(ok_cards):
        pv = E.embed(c["key_points"])
        own += S.support_scores(pv, sent_vecs[c["id"]])
        j = int(sim[i].argmax())                       # same topic, different story
        hard += S.support_scores(pv, sent_vecs[ok_cards[j]["id"]])
        k = rng.randrange(len(ok_cards) - 1); k += k >= i
        rand += S.support_scores(pv, sent_vecs[ok_cards[k]["id"]])
    own, hard, rand = map(np.array, (own, hard, rand))

    sweep = []
    for th in np.round(np.arange(0.30, 0.76, 0.05), 2):
        sweep.append({"threshold": float(th), "real_kept": round(float(np.mean(own >= th)), 3),
                      "hard_rejected": round(float(np.mean(hard < th)), 3),
                      "random_rejected": round(float(np.mean(rand < th)), 3)})
    best = max(sweep, key=lambda r: r["real_kept"] + r["hard_rejected"])   # balance both error types

    summary = {
        "cards_in_history": len(cards), "versions_scanned": n_revs, "cards_with_full_text": len(ok_cards),
        "key_points_tested": int(len(own)),
        "similarity": {
            "own_article": {"median": round(float(np.median(own)), 3), "p10": round(float(np.percentile(own, 10)), 3)},
            "hard_control": {"median": round(float(np.median(hard)), 3), "p90": round(float(np.percentile(hard, 90)), 3)},
            "random_control": {"median": round(float(np.median(rand)), 3), "p90": round(float(np.percentile(rand, 90)), 3)},
        },
        "current_threshold": S.SUPPORT_MIN,
        "best_threshold": best,
        "sweep": sweep, "per_site": per_site, "seconds": round(time.time() - t0),
    }
    (OUT / "fulltext_eval.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")

    md = [f"# Full-text + fact-check test on cards from git history\n",
          f"- {len(cards)} unique cards from {n_revs} versions of `cards.json`; full text for {len(ok_cards)}",
          f"- {len(own)} key points tested\n",
          "| Compared against | Median similarity | |", "|---|---|---|",
          f"| Its own article | {summary['similarity']['own_article']['median']} | 10th pct {summary['similarity']['own_article']['p10']} |",
          f"| Most similar other story (hard) | {summary['similarity']['hard_control']['median']} | 90th pct {summary['similarity']['hard_control']['p90']} |",
          f"| Random other story | {summary['similarity']['random_control']['median']} | 90th pct {summary['similarity']['random_control']['p90']} |\n",
          "| Threshold | Real points kept | Hard-control points rejected | Random points rejected |", "|---|---|---|---|"]
    md += [f"| {r['threshold']:.2f} | {r['real_kept']:.1%} | {r['hard_rejected']:.1%} | {r['random_rejected']:.1%} |" for r in sweep]
    md += ["\n| Site | Cards | Full text | Blocked by robots | Short/empty | Errors | Median chars |", "|---|---|---|---|---|---|---|"]
    md += [f"| {h} | {v['cards']} | {v.get('ok', 0)} | {v.get('robots', 0)} | {v.get('short', 0)} | {v.get('error', 0)} | {v['median_chars']} |"
           for h, v in per_site.items() if v["cards"] >= 5]
    (OUT / "fulltext_eval.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("cards_in_history", "cards_with_full_text", "key_points_tested",
                                              "similarity", "best_threshold")}, indent=1))


if __name__ == "__main__":
    main()
