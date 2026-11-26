"""Feedforward network (MLP) that predicts a story's category and importance from its embedding.

It learns from the LLM's own labels on past cards (about 1,000 free training examples), then
scores new stories *before* any LLM call. That makes ranking smarter at zero API cost, and gives
a measurable comparison: how often does a tiny 50K-parameter network agree with a 120B LLM?
"""
from collections import Counter

import numpy as np

MIN_TRAIN = 80          # fewer labeled cards than this -> skip (not enough to learn from)
HIDDEN = (128,)


class Predictor:
    def __init__(self):
        self.models = {}
        self.metrics = {}

    @property
    def ready(self):
        return bool(self.models)

    def fit(self, cards, vecs, seed=0):
        """cards: list of card dicts (with LLM labels); vecs: matching (n, d) array."""
        from sklearn.model_selection import train_test_split
        from sklearn.neural_network import MLPClassifier

        if len(cards) < MIN_TRAIN:
            self.metrics = {"skipped": f"only {len(cards)} labeled cards (need {MIN_TRAIN})"}
            return self
        X = np.asarray(vecs, dtype=np.float32)
        for target in ("category", "importance"):
            y = np.array([str(c.get(target, "")) for c in cards])
            counts = Counter(y)
            strat = y if min(counts.values()) >= 2 else None
            Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=seed, stratify=strat)
            clf = MLPClassifier(hidden_layer_sizes=HIDDEN, alpha=1e-3, max_iter=400,
                                early_stopping=True, random_state=seed)
            clf.fit(Xtr, ytr)
            pred = clf.predict(Xte)
            majority = Counter(ytr).most_common(1)[0][0]
            m = {"accuracy": round(float((pred == yte).mean()), 3),
                 "baseline_majority": round(float((yte == majority).mean()), 3),
                 "n_train": int(len(ytr)), "n_test": int(len(yte)),
                 "params": int(sum(w.size for w in clf.coefs_) + sum(b.size for b in clf.intercepts_))}
            if target == "importance":
                m["within_1_star"] = round(float(np.mean(np.abs(pred.astype(int) - yte.astype(int)) <= 1)), 3)
            self.metrics[target] = m
            # refit on everything for the real predictions
            self.models[target] = MLPClassifier(hidden_layer_sizes=HIDDEN, alpha=1e-3, max_iter=400,
                                                early_stopping=True, random_state=seed).fit(X, y)
        return self

    def predict(self, vecs):
        """-> list of {"category": str, "importance": int, "confidence": float}."""
        if not self.ready or len(vecs) == 0:
            return [None] * len(vecs)
        X = np.asarray(vecs, dtype=np.float32)
        cat = self.models["category"].predict(X)
        imp_p = self.models["importance"].predict_proba(X)
        classes = self.models["importance"].classes_.astype(int)
        expected = imp_p @ classes                      # expected stars, smoother than argmax for ranking
        best = classes[imp_p.argmax(1)]
        conf = self.models["category"].predict_proba(X).max(1)
        return [{"category": str(c), "importance": int(b), "expected_importance": round(float(e), 2),
                 "confidence": round(float(p), 2)} for c, b, e, p in zip(cat, best, expected, conf)]
