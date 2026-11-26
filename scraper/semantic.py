"""Uses the encoder's vectors: semantic dedupe and related cards (pure numpy, easy to test)."""
import numpy as np

DUP_THRESHOLD = 0.80      # cosine similarity >= this = same story. Tuned on 132 real stories:
                          # catches 87% of true duplicates, flags ~2% of others (see eval/dedupe_eval.py)
RELATED_MIN = 0.45        # below this, a "related" card isn't really related
RELATED_K = 4


def semantic_dedupe(items, item_vecs, existing_vecs, threshold=DUP_THRESHOLD):
    """Keep items whose meaning isn't already covered by an existing card or an earlier kept item.

    items are assumed sorted best-first (so the original post wins over a rewrite).
    Returns (kept_items, kept_vecs, dropped) where dropped = [(item, similar_to_text, sim)].
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
            dropped.append((it, who, round(best, 3)))
            continue
        kept.append(it); kept_v.append(v)
    kv = np.stack(kept_v) if kept_v else np.zeros((0, dim), np.float32)
    return kept, kv, dropped


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
