"""Uses the encoder's vectors: semantic dedupe and related cards (pure numpy, easy to test)."""
import numpy as np

DUP_THRESHOLD = 0.80      # cosine similarity >= this = same story. Tuned on 132 real stories:
                          # catches 87% of true duplicates, flags ~2% of others (see eval/dedupe_eval.py)
FOLLOWUP_HOURS = 36       # a similar story about a card older than this is a follow-up, not a repeat...
SAME_STORY = 0.92         # ...unless it's this close, which really is the same article again
RELATED_MIN = 0.45        # below this, a "related" card isn't really related
RELATED_K = 4


def semantic_dedupe(items, item_vecs, existing_vecs, threshold=DUP_THRESHOLD, existing_age_h=None,
                    followup_hours=FOLLOWUP_HOURS, same_story=SAME_STORY):
    """Keep items whose meaning isn't already covered by an existing card or an earlier kept item.

    items are assumed sorted best-first (so the higher-scored write-up wins, not whichever came first).
    existing_age_h: optional hours since each existing card was added. A new item that matches an
    older card (> followup_hours) is kept as a follow-up ("X released" -> "X pulled") unless it is
    near-identical (>= same_story). Kept follow-ups get it["extra"]["followup_of"] = card index.
    Returns (kept_items, kept_vecs, dropped) where dropped = [(item, (kind, index), sim)].
    """
    dim = item_vecs.shape[1] if len(item_vecs) else 384
    kept, kept_v, dropped = [], [], []
    base = np.asarray(existing_vecs, np.float32) if existing_vecs is not None and len(existing_vecs) \
        else np.zeros((0, dim), np.float32)
    for it, v in zip(items, item_vecs):
        best, who = -1.0, None
        if len(base):
            s = base @ v
            j = int(s.argmax()); best = float(s[j]); who = ("card", j)
        if kept_v:
            s2 = np.stack(kept_v) @ v
            j2 = int(s2.argmax())
            if float(s2[j2]) > best:
                best, who = float(s2[j2]), ("item", j2)
        if best >= threshold:
            followup = (who and who[0] == "card" and existing_age_h is not None
                        and existing_age_h[who[1]] > followup_hours and best < same_story)
            if not followup:
                dropped.append((it, who, round(best, 3)))
                continue
            it.setdefault("extra", {})["followup_of"] = who[1]
        kept.append(it); kept_v.append(v)
    kv = np.stack(kept_v) if kept_v else np.zeros((0, dim), np.float32)
    return kept, kv, dropped


SUPPORT_MIN = 0.45        # key point counts as supported if an article sentence is this similar. Checked on 16 real
                          # cards: own-article points median 0.69, unrelated-article points 90th pct 0.31


def split_sentences(text, min_len=25, max_n=120):
    """Rough sentence split for grounding checks (no extra dependencies)."""
    import re
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])", " ".join((text or "").split()))
    return [p for p in parts if len(p) >= min_len][:max_n]


def support_scores(point_vecs, sent_vecs):
    """For each key point, the similarity of its closest article sentence (0 if no sentences)."""
    if len(point_vecs) == 0:
        return []
    if len(sent_vecs) == 0:
        return [0.0] * len(point_vecs)
    return [round(float(x), 3) for x in (np.asarray(point_vecs) @ np.asarray(sent_vecs).T).max(axis=1)]


def related(ids, vecs, k=RELATED_K, min_sim=RELATED_MIN, dup=DUP_THRESHOLD + 0.1):
    """id -> up to k most similar other cards (skipping near-identical ones)."""
    if len(ids) < 2:
        return {i: [] for i in ids}
    m = np.asarray(vecs, dtype=np.float32)
    s = m @ m.T
    np.fill_diagonal(s, -1)
    out = {}
    for a, row in zip(ids, s):
        order = np.argsort(-row)[: k * 3]
        out[a] = [ids[j] for j in order if min_sim <= row[j] < dup][:k]
    return out
