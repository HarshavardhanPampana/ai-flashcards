# run: python -m scraper.main            (needs GROQ_API_KEY or GEMINI_API_KEY)
#      python -m scraper.main --no-llm   (local test: plain cards, nothing marked as seen)
#      python -m scraper.main --no-ml    (skip the encoder + MLP steps)
"""Pipeline:
  fetch -> fuzzy dedupe -> [encoder] semantic dedupe -> [FNN] MLP scores -> rank top N
  -> [LLM] write cards -> [encoder] embed cards + related cards -> save cards/embeddings/stats
"""
import argparse
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from .config import RSS_SOURCES, ARXIV_CATEGORIES, KEYWORDS
from . import fetchers as f
from .dedupe import load_seen, save_seen, dedupe
from .rank import top_n, score
from .summarize import summarize, basic_card, llm_available, TOKENS

CARDS = Path("docs/cards.json")
STATS = Path("docs/stats.json")
COMPARE_INPUTS = Path("data/compare_inputs.json")   # recent LLM inputs, reused by gen/compare.py
MAX_CARDS = int(os.environ.get("MAX_CARDS_PER_RUN", 40))
KEEP_DAYS = 14
MAX_CARDS_TOTAL = 1000   # keeps cards.json small and the site fast
MAX_FAILS_IN_A_ROW = 3
EXPLORE = int(os.environ.get("EXPLORE_PER_RUN", 4))   # random lower-ranked stories the LLM labels anyway,
                                                       # so the MLP also learns from stories it underrated
SLEEP_BETWEEN_CALLS = float(os.environ.get("SLEEP_BETWEEN_CALLS", 0))  # extra pause; providers pace themselves


def safe(fn, *a):
    try:
        return fn(*a)
    except Exception as e:
        print(f"[source error] {fn.__name__}{'(' + a[0]['name'] + ')' if a and isinstance(a[0], dict) else ''}: {e}")
        return []


def collect():
    items = []
    for s in RSS_SOURCES:
        got = safe(f.fetch_rss, s)
        print(f"  {s['name']}: {len(got)}")
        items += got
    for name, fn, args in (("arXiv", f.fetch_arxiv, (ARXIV_CATEGORIES,)),
                           ("HF Daily Papers", f.fetch_hf_daily, ()),
                           ("Hacker News", f.fetch_hn, (KEYWORDS,))):
        got = safe(fn, *args)
        print(f"  {name}: {len(got)}")
        items += got
    return items


class ML:
    """Encoder + MLP steps. Any failure turns ML off for the run instead of breaking it."""

    def __init__(self, enabled):
        self.on = enabled
        self.vecs = {}           # card id -> vector
        self.mlp = None
        self.info = {}
        if not enabled:
            return
        try:
            import numpy  # noqa: F401
            from . import embed
            self.embed = embed
            self.vecs = embed.load_store()
        except Exception as e:
            self.off(f"encoder unavailable ({e})")

    def off(self, why):
        print(f"[ml] {why}; continuing without ML")
        self.on = False
        self.info["error"] = why

    def backfill(self, cards):
        """Embed any card that has no vector yet (e.g. the first run, or older cards)."""
        if not self.on:
            return
        try:
            missing = [c for c in cards if c["id"] not in self.vecs]
            if missing:
                t = time.time()
                for c, v in zip(missing, self.embed.embed([self.embed.card_text(c) for c in missing])):
                    self.vecs[c["id"]] = v
                print(f"[encoder] embedded {len(missing)} cards in {time.time() - t:.1f}s")
        except Exception as e:
            self.off(f"embedding failed ({e})")

    def train(self, cards):
        if not self.on:
            return
        try:
            import numpy as np
            from .mlp import Predictor
            labeled = [c for c in cards if not c.get("no_llm") and c["id"] in self.vecs]
            t = time.time()
            self.mlp = Predictor().fit(labeled, np.stack([self.vecs[c["id"]] for c in labeled]) if labeled else [])
            self.info["mlp"] = self.mlp.metrics
            m = self.mlp.metrics
            if self.mlp.ready:
                print(f"[mlp] trained on {m['category']['n_train']} cards in {time.time() - t:.1f}s: "
                      f"category acc {m['category']['accuracy']} (baseline {m['category']['baseline_majority']}), "
                      f"importance within ±1 star {m['importance']['within_1_star']}")
            else:
                print(f"[mlp] {m.get('skipped')}")
        except Exception as e:
            print(f"[mlp] training failed ({e}); ranking without it")
            self.mlp = None

    def semantic_filter(self, items, cards):
        """-> (kept items, their vectors, dropped examples)."""
        if not self.on or not items:
            return items, None, []
        try:
            import numpy as np
            from .semantic import semantic_dedupe
            iv = self.embed.embed([self.embed.item_text(it) for it in items])
            ids = [c["id"] for c in cards if c["id"] in self.vecs]
            base = np.stack([self.vecs[i] for i in ids]) if ids else None
            by_id = {c["id"]: c for c in cards}
            now = datetime.now(timezone.utc)

            def age_h(c):
                try:
                    return (now - datetime.fromisoformat(c.get("added", ""))).total_seconds() / 3600
                except ValueError:
                    return 0.0
            ages = [age_h(by_id[i]) for i in ids]
            kept, kv, dropped = semantic_dedupe(items, iv, base, existing_age_h=ages)
            for it in kept:                                   # follow-ups point at the earlier card
                j = it["extra"].pop("followup_of", None)
                if j is not None:
                    it["extra"]["followup_to"] = ids[j]
            self.info["followups"] = sum(1 for it in kept if it["extra"].get("followup_to"))
            examples = []
            for it, (kind, j), sim in dropped[:8]:
                other = by_id[ids[j]]["headline"] if kind == "card" else kept[j]["title"]
                examples.append({"new": it["title"], "matches": other, "similarity": sim, "source": it["source"]})
            return kept, kv, examples
        except Exception as e:
            self.off(f"semantic dedupe failed ({e})")
            return items, None, []

    def score_items(self, items, item_vecs):
        """Attach MLP predictions to items (used by ranking and shown on the card)."""
        if not (self.on and self.mlp and self.mlp.ready and item_vecs is not None):
            return
        for it, p in zip(items, self.mlp.predict(item_vecs)):
            it["extra"]["mlp"] = p

    def ground(self, card, text, min_text=300):
        """Check each key point against the article's sentences; drop unsupported ones (keeping at least 2).
        Adds card["grounding"] = {checked, supported, dropped}. Skipped when there's too little article text."""
        if not self.on or len(text or "") < min_text or not card.get("key_points"):
            return None
        try:
            from .semantic import split_sentences, support_scores, SUPPORT_MIN
            pts = card["key_points"]
            scores = support_scores(self.embed.embed(pts), self.embed.embed(split_sentences(text)))
            keep = [p for p, sc in zip(pts, scores) if sc >= SUPPORT_MIN]
            if len(keep) < 2:                                      # never leave a card with fewer than 2 points
                keep = [p for _, p in sorted(zip(scores, pts), reverse=True)[:max(2, len(keep))]]
                keep = [p for p in pts if p in keep]               # original order
            info = {"checked": len(pts), "supported": sum(sc >= SUPPORT_MIN for sc in scores),
                    "dropped": len(pts) - len(keep)}
            card["key_points"] = keep
            card["grounding"] = info
            return info
        except Exception as e:
            print(f"[ground] skipped ({e})")
            return None

    def finish(self, cards):
        """Embed new cards, compute related cards, save vectors. Mutates cards (adds 'related')."""
        if not self.on:
            return
        try:
            import numpy as np
            from .semantic import related
            self.backfill(cards)
            ids = [c["id"] for c in cards if c["id"] in self.vecs]
            rel = related(ids, np.stack([self.vecs[i] for i in ids])) if ids else {}
            for c in cards:
                c["related"] = rel.get(c["id"], [])
            self.embed.save_store(self.vecs, [c["id"] for c in cards])
        except Exception as e:
            self.off(f"related/save failed ({e})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true", help="build plain cards without an LLM")
    ap.add_argument("--no-ml", action="store_true", help="skip the encoder and MLP steps")
    ap.add_argument("--max", type=int, default=MAX_CARDS)
    args = ap.parse_args()
    t0 = time.time()

    use_llm = not args.no_llm
    if use_llm and not llm_available():
        raise SystemExit("No GROQ_API_KEY or GEMINI_API_KEY set. Add one to .env, "
                         "or run with --no-llm to test without an LLM.")

    old = json.loads(CARDS.read_text(encoding="utf-8")) if CARDS.exists() else []
    seen = load_seen()
    ml = ML(enabled=not args.no_ml)
    ml.backfill(old)
    ml.train(old)

    print("fetching...")
    items = collect()
    items.sort(key=score, reverse=True)
    # 1) exact + fuzzy dedupe (already-seen ids, near-identical titles)
    fresh = dedupe(items, seen if use_llm else [],
                   existing_titles=[c.get("headline", "") for c in old if not c.get("no_llm")])
    # 2) semantic dedupe with the encoder (same story, different words)
    fresh_sem, fresh_vecs, dup_examples = ml.semantic_filter(fresh, [c for c in old if not c.get("no_llm")])
    # 3) the MLP scores what's left, then rank (score() adds the MLP's stars)
    ml.score_items(fresh_sem, fresh_vecs)
    picked = pick_with_exploration(fresh_sem, args.max, EXPLORE if ml.mlp else 0)
    n_explore = sum(1 for it in picked if it["extra"].get("explore"))
    print(f"collected={len(items)} after_fuzzy={len(fresh)} after_semantic={len(fresh_sem)} "
          f"summarizing={len(picked)} (exploring {n_explore})")

    new_cards, streak, aborted, llm_inputs = [], [], False, []
    n_full, ground_tot = 0, {"checked": 0, "dropped": 0}
    for i, it in enumerate(picked, 1):
        if use_llm:
            # give the LLM the full article instead of the short feed snippet (falls back to the snippet)
            try:
                full = f.fetch_article_text(it["url"])
            except Exception:
                full = ""
            if not full and len(it["text"]) < 200 and it["source"] == "Hacker News":
                try:
                    full = f.fetch_page_text(it["url"])
                except Exception:
                    full = ""
            if len(full) > len(it["text"]):
                it["text"] = full
                n_full += 1
            card = summarize(it)
            if card:
                g = ml.ground(card, it["text"])                    # drop key points the article doesn't support
                if g:
                    ground_tot["checked"] += g["checked"]; ground_tot["dropped"] += g["dropped"]
            if card:
                # mark seen after attempting, so one-off failures don't loop forever
                seen.extend(streak + [it["id"]])
                streak = []
                llm_inputs.append({k: it[k] for k in ("id", "title", "text", "source", "url", "published")})
            else:
                streak.append(it["id"])
                if len(streak) >= MAX_FAILS_IN_A_ROW:
                    # likely a config problem (key/model/quota): stop, and leave these unseen
                    print(f"[abort] {len(streak)} LLM failures in a row - check your API keys "
                          "(GROQ_API_KEY / GEMINI_API_KEY) and free-tier quotas")
                    streak, aborted = [], True
                    break
            time.sleep(SLEEP_BETWEEN_CALLS)
        else:
            card = basic_card(it)
        if card:
            card["added"] = datetime.now(timezone.utc).isoformat()
            if it["extra"].get("mlp"):
                card["mlp"] = it["extra"]["mlp"]       # what the MLP predicted before the LLM saw it
            if it["extra"].get("explore"):
                card["explore"] = True                 # picked at random, not because the MLP liked it
            if it["extra"].get("followup_to"):
                card["followup_to"] = it["extra"]["followup_to"]
            new_cards.append(card)
            print(f"  [{i}/{len(picked)}] {card['headline'][:70]}")

    cutoff = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).isoformat()
    new_ids = {c["id"] for c in new_cards}
    # real LLM cards replace any earlier --no-llm placeholder with the same id
    merged = new_cards + [c for c in old if c["id"] not in new_ids]
    cards = [c for c in merged if c.get("added", "") >= cutoff]
    cards.sort(key=lambda c: c.get("added", ""), reverse=True)
    cards = cards[:MAX_CARDS_TOTAL]
    ml.finish(cards)
    CARDS.write_text(json.dumps(cards, indent=1, ensure_ascii=False), encoding="utf-8")
    if use_llm:
        save_seen(seen + streak)
        save_compare_inputs(llm_inputs)
    write_stats(cards, {
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "collected": len(items), "after_fuzzy": len(fresh), "after_semantic": len(fresh_sem),
        "fuzzy_removed": len(items) - len(fresh), "semantic_removed": len(fresh) - len(fresh_sem),
        "summarized": len(picked), "cards_added": len(new_cards), "explored": n_explore,
        "followups": ml.info.get("followups", 0),
        "fulltext": n_full, "points_checked": ground_tot["checked"], "points_dropped": ground_tot["dropped"],
        "llm_calls": TOKENS["calls"], "llm_tokens": TOKENS["total"],
        "models": sorted({c.get("model", "") for c in new_cards if c.get("model")}),
        "seconds": round(time.time() - t0),
        "ml": ml.on,
    }, ml, dup_examples)
    print(f"added {len(new_cards)} cards, total {len(cards)}")
    if aborted and not new_cards:
        raise SystemExit(1)   # make the Actions run show red


def pick_with_exploration(items, n, explore, rng=None):
    """Top (n - explore) by score, plus `explore` random picks from the rest.

    Without this the MLP only ever sees LLM labels for stories it already ranked highly, so it can
    never learn that it underrated something (a feedback loop). The random picks fix that."""
    import random
    explore = max(0, min(explore, n // 4))
    top = top_n(items, n - explore)
    chosen = {id(it) for it in top}
    rest = [it for it in items if id(it) not in chosen]
    rng = rng or random.Random()
    extra = rng.sample(rest, min(explore, len(rest)))
    for it in extra:
        it["extra"]["explore"] = True
    if len(extra) < explore:                       # not enough leftovers: fill with ranked picks
        top = top_n(items, n - len(extra))
    return top + extra


def save_compare_inputs(new_inputs, keep=100):
    old = json.loads(COMPARE_INPUTS.read_text(encoding="utf-8")) if COMPARE_INPUTS.exists() else []
    ids = {x["id"] for x in new_inputs}
    rows = new_inputs + [x for x in old if x["id"] not in ids]
    COMPARE_INPUTS.write_text(json.dumps(rows[:keep], indent=1, ensure_ascii=False), encoding="utf-8")


def write_stats(cards, run, ml, dup_examples):
    """docs/stats.json feeds the site's "How it works" page."""
    s = json.loads(STATS.read_text(encoding="utf-8")) if STATS.exists() else {}
    s["runs"] = ([run] + s.get("runs", []))[:60]
    s["updated"] = run["time"]
    s["cards"] = len(cards)
    if ml.info.get("mlp"):
        s["mlp"] = ml.info["mlp"]
    if dup_examples:
        s["semantic_examples"] = (dup_examples + s.get("semantic_examples", []))[:12]
    # live agreement: on cards that have both, how often MLP and LLM agree
    both = [c for c in cards if c.get("mlp") and not c.get("no_llm")]
    if both:
        s["agreement"] = {
            "cards": len(both),
            "category": round(sum(c["mlp"]["category"] == c["category"] for c in both) / len(both), 3),
            "importance_exact": round(sum(c["mlp"]["importance"] == c["importance"] for c in both) / len(both), 3),
            "importance_within_1": round(sum(abs(c["mlp"]["importance"] - c["importance"]) <= 1 for c in both) / len(both), 3),
        }
    STATS.write_text(json.dumps(s, indent=1, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
