"""Encoder model: sentence embeddings with MiniLM (a small BERT-style encoder).

Every card gets a 384-number vector that captures its meaning. They power:
  - semantic dedupe   (same story, different wording)
  - related cards     (nearest neighbours)
  - semantic search   (the site embeds your query with the same model in the browser)
  - the MLP           (its input features)

Vectors are stored in docs/embeddings.json as int8 (4x smaller than float32), so the
browser can download all of them for search.
"""
import base64
import json
import os
from pathlib import Path

import numpy as np

MODEL = "sentence-transformers/all-MiniLM-L6-v2"   # same model as Xenova/all-MiniLM-L6-v2 in the browser
STORE = Path("docs/embeddings.json")
CACHE_DIR = os.environ.get("FASTEMBED_CACHE", ".cache/fastembed")

_model = None


def _get_model():
    global _model
    if _model is None:
        from fastembed import TextEmbedding
        _model = TextEmbedding(MODEL, cache_dir=CACHE_DIR)
    return _model


def embed(texts):
    """List of strings -> (n, 384) float32 array of unit-length vectors."""
    if not texts:
        return np.zeros((0, 384), dtype=np.float32)
    v = np.asarray(list(_get_model().embed(list(texts))), dtype=np.float32)
    return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-9)


def card_text(c):
    return f'{c.get("headline", "")}. {c.get("tldr", "")} {" ".join(c.get("tags", []))}'.strip()


def item_text(it):
    """What we know about a story *before* the LLM sees it (used for dedupe and the MLP)."""
    return f'{it.get("title", "")}. {it.get("text", "")[:400]}'.strip()


# ---------- storage (int8, base64) ----------
def load_store():
    """-> dict id -> float32 vector."""
    if not STORE.exists():
        return {}
    d = json.loads(STORE.read_text(encoding="utf-8"))
    if d.get("model") != MODEL or not d.get("ids"):
        return {}
    q = np.frombuffer(base64.b64decode(d["vecs"]), dtype=np.int8).reshape(len(d["ids"]), d["dim"])
    v = q.astype(np.float32) / 127.0
    v /= np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-9)
    return dict(zip(d["ids"], v))


def save_store(vecs_by_id, order):
    ids = [i for i in order if i in vecs_by_id]
    if not ids:
        STORE.write_text(json.dumps({"model": MODEL, "dim": 384, "ids": [], "vecs": ""}), encoding="utf-8")
        return
    m = np.stack([vecs_by_id[i] for i in ids])
    q = np.clip(np.round(m * 127.0), -127, 127).astype(np.int8)
    STORE.write_text(json.dumps({
        "model": MODEL, "browser_model": "Xenova/all-MiniLM-L6-v2", "dim": int(m.shape[1]),
        "ids": ids, "vecs": base64.b64encode(q.tobytes()).decode("ascii"),
    }), encoding="utf-8")
