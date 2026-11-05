import json
from pathlib import Path

from rapidfuzz import fuzz

SEEN = Path("data/seen.json")


def load_seen():
    """Returns an ordered list (oldest first) of processed ids."""
    return json.loads(SEEN.read_text()) if SEEN.exists() else []


def save_seen(seen, keep_last=5000):
    SEEN.write_text(json.dumps(seen[-keep_last:]))


def dedupe(items, seen, threshold=85, existing_titles=()):
    """Drop already-seen ids and near-duplicate titles. Pass items sorted best-first so
    the original company post wins over a news rewrite."""
    seen = set(seen)
    kept, titles = [], [t.lower() for t in existing_titles]
    for it in items:
        if not it["title"] or it["id"] in seen:
            continue
        t = it["title"].lower()
        if any(fuzz.token_set_ratio(t, k) >= threshold for k in titles):
            continue
        kept.append(it)
        titles.append(t)
    return kept
