"""Fast unit tests (no network, no model downloads). Run: python -m pytest -q"""
import json
import types

import numpy as np
import pytest

from scraper import rank, semantic, summarize
from scraper.dedupe import dedupe
from scraper.fetchers import make_item
from scraper.mlp import Predictor


def item(title, source="OpenAI", category="company", text="", **extra):
    it = make_item(title, f"https://x.test/{abs(hash((title, source)))}", source, "", text, category, extra)
    return it


# ---------- fuzzy dedupe ----------
def test_dedupe_drops_seen_ids_and_near_identical_titles():
    a = item("OpenAI releases GPT-7 with better reasoning")
    b = item("OpenAI releases GPT-7, with better reasoning!", source="TechCrunch AI")
    c = item("Nvidia announces a new GPU")
    kept = dedupe([a, b, c], seen=[c["id"]])
    assert kept == [a]


def test_dedupe_against_existing_titles():
    a = item("Google launches Gemini 4 Carbon")
    assert dedupe([a], seen=[], existing_titles=["Google launches Gemini 4 Carbon"]) == []


# ---------- ranking ----------
def test_mlp_prediction_raises_score():
    low = item("Some model update", mlp={"importance": 1, "expected_importance": 1.0})
    high = item("Some model update", mlp={"importance": 5, "expected_importance": 5.0})
    assert rank.score(high) > rank.score(low)


def test_top_n_caps_papers_and_fills_with_news_first():
    papers = [item(f"Paper {i}", source="HF Daily Papers", category="paper", upvotes=500) for i in range(20)]
    news = [item(f"News {i}", source=f"Src{i % 5}", category="news") for i in range(10)]
    picked = rank.top_n(papers + news, 12)
    n_papers = sum(p["category"] == "paper" for p in picked)
    assert len(picked) == 12
    assert n_papers <= 12 // 3 + 2        # papers capped; leftover slots prefer news


# ---------- semantic dedupe + related ----------
def unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v)


def test_semantic_dedupe_against_cards_and_within_batch():
    existing = np.stack([unit([1, 0, 0])])
    items = [item("A"), item("B"), item("C")]
    vecs = np.stack([unit([0.99, 0.1, 0]),      # same as existing card -> drop
                     unit([0, 1, 0]),            # new
                     unit([0, 0.98, 0.15])])     # same as item B -> drop
    kept, kv, dropped = semantic.semantic_dedupe(items, vecs, existing, threshold=0.8)
    assert [k["title"] for k in kept] == ["B"]
    assert kv.shape == (1, 3)
    assert [d[1][0] for d in dropped] == ["card", "item"]


def test_semantic_dedupe_keeps_follow_ups_to_older_cards():
    existing = np.stack([unit([1, 0, 0]), unit([0, 0, 1])])
    items = [item("follow-up"), item("repeat"), item("same article")]
    vecs = np.stack([unit([0.85, 0.5, 0]),      # ~0.86 to an old card -> follow-up, keep
                     unit([0.1, 0, 0.99]),       # ~0.99 to a fresh card -> repeat, drop
                     unit([0.99, 0.05, 0])])     # ~0.999 to the old card -> same article, drop
    kept, _, dropped = semantic.semantic_dedupe(items, vecs, existing, threshold=0.8,
                                                existing_age_h=[72, 2])
    assert [k["title"] for k in kept] == ["follow-up"]
    assert kept[0]["extra"]["followup_of"] == 0
    assert len(dropped) == 2


def test_exploration_adds_random_lower_ranked_items():
    import random
    from scraper.main import pick_with_exploration
    items = [{"title": f"t{i}", "text": "", "source": f"s{i % 8}", "category": "news",
              "extra": {"points": 1000 - i}} for i in range(40)]
    picked = pick_with_exploration(items, 12, 3, rng=random.Random(0))
    assert len(picked) == 12
    explored = [p for p in picked if p["extra"].get("explore")]
    assert len(explored) == 3
    assert len({id(p) for p in picked}) == 12       # no duplicates


def test_related_skips_self_and_near_duplicates():
    ids = ["a", "b", "c", "d"]
    vecs = np.stack([unit([1, 0, 0]), unit([0.8, 0.6, 0]), unit([0, 0, 1]), unit([1, 0.001, 0])])
    rel = semantic.related(ids, vecs, k=2, min_sim=0.5, dup=0.95)
    assert rel["a"] == ["b"]            # d is a near-duplicate of a, c is unrelated
    assert "a" not in rel["a"]


# ---------- MLP ----------
def test_mlp_learns_separable_labels():
    rng = np.random.default_rng(0)
    centers = {"paper": unit([1, 0, 0, 0]), "product": unit([0, 1, 0, 0]), "funding": unit([0, 0, 1, 0])}
    stars = {"paper": 2, "product": 3, "funding": 4}
    cards, X = [], []
    for cat, c in centers.items():
        for _ in range(60):
            cards.append({"category": cat, "importance": stars[cat]})
            X.append(unit(c + rng.normal(0, 0.05, 4)))
    p = Predictor().fit(cards, np.stack(X))
    assert p.ready and p.metrics["category"]["accuracy"] > 0.9
    out = p.predict(np.stack([centers["funding"]]))[0]
    assert out["category"] == "funding" and out["importance"] == 4


def test_mlp_skips_with_too_little_data():
    p = Predictor().fit([{"category": "paper", "importance": 2}] * 5, np.zeros((5, 4)))
    assert not p.ready and "skipped" in p.metrics
    assert p.predict(np.zeros((2, 4))) == [None, None]


# ---------- LLM output handling ----------
def test_parse_json_strips_code_fences():
    assert summarize._parse_json('```json\n{"headline": "H"}\n```') == {"headline": "H"}


def test_clean_coerces_bad_values():
    c = summarize._clean({"headline": " H ", "category": "Model_Release", "importance": "9",
                          "key_points": "one", "tags": [1, 2, 3, 4, 5]})
    assert c["headline"] == "H" and c["category"] == "model_release" and c["importance"] == 5
    assert c["key_points"] == ["one"] and c["tags"] == ["1", "2", "3", "4"]
    assert summarize._clean({"category": "weird"})["category"] == "other"


def test_summarize_falls_back_to_next_provider(monkeypatch):
    monkeypatch.setattr(summarize.time, "sleep", lambda s: None)
    monkeypatch.setenv("GROQ_API_KEY", "k")
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    g, m = summarize.Groq(), summarize.Gemini()
    monkeypatch.setattr(summarize, "PROVIDERS", {"groq": g, "gemini": m})
    g.models, m.models = ["g1"], ["m1"]
    g.min_interval = m.min_interval = 0

    def groq_bad_key(model, prompt):
        raise summarize.FatalLLMError("bad key")
    g.call = groq_bad_key
    m.call = lambda model, prompt: json.dumps({"headline": "OK", "category": "paper", "importance": 3})
    it = item("A story", text="x" * 300)
    card = summarize.summarize(it)
    assert card["headline"] == "OK" and card["model"] == "m1"
    assert g.disabled


def test_summarize_moves_to_next_model_when_overloaded(monkeypatch):
    monkeypatch.setattr(summarize.time, "sleep", lambda s: None)
    monkeypatch.setenv("GROQ_API_KEY", "k")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    g = summarize.Groq()
    monkeypatch.setattr(summarize, "PROVIDERS", {"groq": g, "gemini": summarize.Gemini()})
    g.models, g.min_interval = ["busy", "ok"], 0

    def call(model, prompt):
        if model == "busy":
            raise summarize.ModelUnavailable("rate limited")
        return '{"headline": "Fine", "importance": 2}'
    g.call = call
    card = summarize.summarize(item("Story", text="y" * 300))
    assert card["headline"] == "Fine" and card["model"] == "ok"


# ---------- pre-rendered top stories ----------
def test_prerender_bakes_escaped_top_stories_between_markers():
    from scraper import prerender
    page = ("<head><!-- prerender-head:start --><!-- prerender-head:end --></head>"
            "<main><!-- prerender-body:start -->old<!-- prerender-body:end --></main>")
    cards = [{"headline": f"Story {i} <b>", "tldr": "t & t", "url": f"https://x.test/{i}", "source": "S",
              "category": "news", "importance": i % 5 + 1, "added": "2099-01-01T00:00:00+00:00"} for i in range(8)]
    out = prerender.render(page, cards)
    assert out.count('class="seo-card"') == 5
    assert "old" not in out and "<b>" not in out and "&lt;b&gt;" in out
    assert 'property="og:title"' in out
    assert prerender.render(out, cards) == out        # idempotent: re-running changes nothing



# ---------- full text + grounding ----------
def test_split_sentences_and_support_scores():
    sents = semantic.split_sentences("OpenAI released a new model today. It is twice as fast as the old one! ok. The price did not change. Tiny.")
    assert sents == ["OpenAI released a new model today.", "It is twice as fast as the old one! ok.", "The price did not change."]
    pts = np.stack([unit([1, 0, 0]), unit([0, 1, 0])])
    sv = np.stack([unit([0.9, 0.1, 0]), unit([0, 0, 1])])
    sc = semantic.support_scores(pts, sv)
    assert sc[0] > 0.9 and sc[1] < 0.2
    assert semantic.support_scores(pts, np.zeros((0, 3))) == [0.0, 0.0]


def test_ground_drops_unsupported_points_but_keeps_two():
    from scraper.main import ML
    ml = ML.__new__(ML); ml.on = True; ml.info = {}
    vec = {"supported claim": [1, 0, 0], "another supported": [0.95, 0.3, 0], "made up": [0, 0, 1]}

    class FakeEmbed:
        @staticmethod
        def embed(texts):
            return np.stack([unit(vec.get(t, [1, 0.05, 0])) for t in texts]) if texts else np.zeros((0, 3))
    ml.embed = FakeEmbed
    article = "Sentence about the real claim number one here. " * 10
    card = {"key_points": ["supported claim", "made up", "another supported"]}
    info = ml.ground(card, article)
    assert card["key_points"] == ["supported claim", "another supported"]
    assert info == {"checked": 3, "supported": 2, "dropped": 1}
    card2 = {"key_points": ["made up", "supported claim"]}          # never fewer than 2 points
    ml.ground(card2, article)
    assert len(card2["key_points"]) == 2
    assert ml.ground({"key_points": ["x"]}, "too short") is None   # not enough article text to judge
