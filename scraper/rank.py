import math
import re

from .config import RSS_SOURCES, KEYWORDS

WEIGHTS = {s["name"]: s["weight"] for s in RSS_SOURCES}
WEIGHTS.update({"arXiv": 1.0, "HF Daily Papers": 2.5, "Hacker News": 1.5})

# word-boundary match so "model" doesn't match inside unrelated words like "remodel"
_KW = [re.compile(r"\b" + re.escape(k) + r"\b") for k in KEYWORDS]


def score(it):
    s = WEIGHTS.get(it["source"], 1.0)
    text = (it["title"] + " " + it["text"][:500]).lower()
    s += 0.5 * sum(bool(k.search(text)) for k in _KW)
    s += math.log1p(it["extra"].get("upvotes", 0) or 0) * 0.8   # HF papers
    s += math.log1p(it["extra"].get("points", 0) or 0) * 0.5    # Hacker News
    return s


def top_n(items, n):
    """Pick the best n, with caps so papers (HF upvotes score high) don't crowd out
    company/news items: papers <= n/3 overall, arXiv <= n/4, any one source <= n/4.
    If caps leave slots empty, fill them with the best remaining items."""
    items = sorted(items, key=score, reverse=True)
    cap = max(1, n // 4)
    out, rest, per_source, papers = [], [], {}, 0
    for it in items:
        is_paper = it["category"] == "paper"
        if per_source.get(it["source"], 0) >= cap or (is_paper and papers >= max(1, n // 3)):
            rest.append(it)
            continue
        per_source[it["source"]] = per_source.get(it["source"], 0) + 1
        papers += is_paper
        out.append(it)
        if len(out) >= n:
            return out
    return out + rest[: n - len(out)]
