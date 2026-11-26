"""Evaluate semantic (encoder) dedupe vs fuzzy title matching on real data.

Ground truth comes for free: stories fetched now that already have a card ARE duplicates of that
card. For each one we compare the story's raw text with (a) its own card and (b) the most similar
OTHER card, then report how many true duplicates each threshold catches and how many unrelated
stories it would wrongly drop.

  python -m eval.dedupe_eval            (needs network; ~1 minute)
Writes data/dedupe_eval.json.
"""
import contextlib
import io
import json
from pathlib import Path

import numpy as np
from rapidfuzz import fuzz

from scraper import embed as E
from scraper.main import collect

OUT = Path("data/dedupe_eval.json")


def main():
    cards = json.loads(Path("docs/cards.json").read_text(encoding="utf-8"))
    by_id = {c["id"]: i for i, c in enumerate(cards)}
    with contextlib.redirect_stdout(io.StringIO()):
        items = collect()
    match = [it for it in items if it["id"] in by_id]
    if len(match) < 10:
        raise SystemExit(f"only {len(match)} fetched stories have cards; run again after a scraper run")

    C = E.embed([E.card_text(c) for c in cards])
    I = E.embed([E.item_text(it) for it in match])
    S = I @ C.T
    own = np.array([S[k, by_id[it["id"]]] for k, it in enumerate(match)])
    other = np.array([np.max(np.delete(S[k], by_id[it["id"]])) for k, it in enumerate(match)])

    # fuzzy baseline: title vs the card's headline (the LLM rewrites headlines, so this is hard)
    fz_own = np.array([fuzz.token_set_ratio(it["title"].lower(), cards[by_id[it["id"]]]["headline"].lower())
                       for it in match])

    rows = []
    for t in (0.70, 0.75, 0.78, 0.80, 0.82, 0.85, 0.90):
        rows.append({"threshold": t, "recall": round(float(np.mean(own >= t)), 3),
                     "false_flag_rate": round(float(np.mean(other >= t)), 3)})
    res = {
        "stories": len(match),
        "semantic": rows,
        "fuzzy_recall_at_85": round(float(np.mean(fz_own >= 85)), 3),
        "similarity_same_story_median": round(float(np.median(own)), 3),
        "similarity_best_other_median": round(float(np.median(other)), 3),
    }
    OUT.write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(f"{len(match)} known duplicates")
    print(f"fuzzy title match (>=85) catches {res['fuzzy_recall_at_85']:.0%}")
    for r in rows:
        print(f"semantic >= {r['threshold']:.2f}: catches {r['recall']:.0%}, wrongly flags {r['false_flag_rate']:.0%}")


if __name__ == "__main__":
    main()
