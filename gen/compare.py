"""Decoder comparison: the same story, summarized by small LOCAL decoders vs the big API model.

The live site uses gpt-oss-120b through Groq. This script runs open decoder models on CPU with
Hugging Face transformers (by default Qwen2.5-0.5B and Qwen2.5-1.5B), gives each the exact same
prompt and input, and measures per model:
  - does it return valid JSON in the card format?
  - how long does it take on CPU, and how many tokens per second?
  - does it agree with the big model on category and stars?
  - how similar are the TL;DRs in meaning? (MiniLM encoder cosine similarity)
Proportions come with 95% Wilson confidence intervals, so small samples look as uncertain as
they are. Results accumulate across runs (up to KEEP stories).

  python -m gen.compare                      # COMPARE_N (default 15) new stories per model
  LOCAL_MODELS=Qwen/Qwen2.5-0.5B-Instruct python -m gen.compare
Writes docs/compare.json, shown on the site's "How it works" page.
"""
import gc
import json
import math
import os
import time
from pathlib import Path

from scraper.summarize import PROMPT, TITLE_ONLY_NOTE, _clean, _parse_json

INPUTS = Path("data/compare_inputs.json")
CARDS = Path("docs/cards.json")
OUT = Path("docs/compare.json")
MODELS = [m.strip() for m in os.environ.get(
    "LOCAL_MODELS", "Qwen/Qwen2.5-0.5B-Instruct,Qwen/Qwen2.5-1.5B-Instruct").split(",") if m.strip()]
N = int(os.environ.get("COMPARE_N", 15))
KEEP = 200
EMPTY = {"headline": "", "tldr": "", "key_points": [], "why_it_matters": "",
         "category": "other", "importance": 1, "tags": [], "companies": []}


def build_prompt(it):
    short = len(it["text"]) < 200
    return PROMPT.format(source=it["source"], title=it["title"], text=it["text"][:2500] or "(none)",
                         title_only_note=TITLE_ONLY_NOTE if short else "")


def load_model(name):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    torch.set_num_threads(max(1, os.cpu_count() or 1))
    tok = AutoTokenizer.from_pretrained(name)
    model = AutoModelForCausalLM.from_pretrained(name, dtype=torch.float32)
    model.eval()
    return tok, model


def generate(tok, model, prompt, max_new_tokens=520):
    import torch
    ids = tok.apply_chat_template([{"role": "user", "content": prompt}],
                                  add_generation_prompt=True, return_tensors="pt")
    if not hasattr(ids, "shape"):        # newer transformers may return a dict
        ids = ids["input_ids"]
    t = time.time()
    with torch.no_grad():
        out = model.generate(ids, max_new_tokens=max_new_tokens, do_sample=False,
                             pad_token_id=tok.eos_token_id)
    new = out[0, ids.shape[1]:]
    return tok.decode(new, skip_special_tokens=True), time.time() - t, int(new.shape[0])


def tldr_similarity(a, b):
    try:
        from scraper.embed import embed
        v = embed([a, b])
        return round(float(v[0] @ v[1]), 3)
    except Exception:
        return None


def wilson(k, n, z=1.96):
    """95% confidence interval for a proportion k/n -> [low, high]."""
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0.0, c - h), 3), round(min(1.0, c + h), 3)]


def summarize_model(items, model):
    rows = [x for x in items if model in x["locals"]]
    n = len(rows)
    if not n:
        return {"n": 0}
    loc = [x["locals"][model] for x in rows]
    ok = [(x, x["locals"][model]) for x in rows if x["locals"][model]["valid_json"]]
    cat = sum(l["card"]["category"] == x["api"]["category"] for x, l in ok)
    imp = sum(abs(l["card"]["importance"] - x["api"]["importance"]) <= 1 for x, l in ok)
    sims = [l["tldr_similarity"] for _, l in ok if l.get("tldr_similarity") is not None]
    return {
        "n": n, "valid": len(ok),
        "json_valid_rate": round(len(ok) / n, 3), "json_valid_ci": wilson(len(ok), n),
        "avg_seconds": round(sum(l["seconds"] for l in loc) / n, 1),
        "avg_tokens_per_second": round(sum(l["tokens_per_second"] for l in loc) / n, 1),
        "category_agreement": round(cat / len(ok), 3) if ok else None,
        "category_ci": wilson(cat, len(ok)) if ok else None,
        "importance_within_1": round(imp / len(ok), 3) if ok else None,
        "importance_ci": wilson(imp, len(ok)) if ok else None,
        "avg_tldr_similarity": round(sum(sims) / len(sims), 3) if sims else None,
    }


def load_previous():
    """Read docs/compare.json, migrating the old single-model format."""
    if not OUT.exists():
        return []
    d = json.loads(OUT.read_text(encoding="utf-8"))
    items = d.get("items", [])
    for x in items:
        if "locals" not in x:                       # old format: one "local" result
            old = x.pop("local", None)
            x["locals"] = {d.get("local_model", "Qwen/Qwen2.5-0.5B-Instruct"): old} if old else {}
            if old and "tldr_similarity" in x:
                old["tldr_similarity"] = x.pop("tldr_similarity")
    return items


def run_model(model, todo, by_id):
    t = time.time()
    tok, lm = load_model(model)
    print(f"[compare] {model} loaded in {time.time() - t:.1f}s; {len(todo)} stories")
    for i, it in enumerate(todo, 1):
        text, secs, ntok = generate(tok, lm, build_prompt(it))
        try:
            card = _clean(_parse_json(text))
            valid = bool(card["headline"])
        except Exception:
            card, valid = dict(EMPTY), False
        row = by_id[it["id"]]
        row["locals"][model] = {
            "card": card, "valid_json": valid, "seconds": round(secs, 1), "tokens": ntok,
            "tokens_per_second": round(ntok / max(secs, 1e-6), 1),
            "raw": None if valid else text[:400],
            "tldr_similarity": tldr_similarity(row["api"].get("tldr", ""), card.get("tldr", "")) if valid else None,
        }
        print(f"  [{i}/{len(todo)}] {secs:.0f}s valid={valid} cat {card['category']} vs {row['api']['category']}"
              f"  | {it['title'][:50]}")
    del lm, tok
    gc.collect()


def main():
    inputs = json.loads(INPUTS.read_text(encoding="utf-8")) if INPUTS.exists() else []
    cards = {c["id"]: c for c in json.loads(CARDS.read_text(encoding="utf-8"))}
    items = load_previous()
    by_id = {x["id"]: x for x in items}

    # every usable input gets a row, with the API model's card as the reference answer
    for it in inputs:
        if it["id"] in cards and it["id"] not in by_id:
            api = cards[it["id"]]
            row = {"id": it["id"], "title": it["title"], "source": it["source"], "url": it["url"],
                   "api": {k: api.get(k) for k in ("headline", "tldr", "key_points", "why_it_matters",
                                                   "category", "importance", "model")},
                   "locals": {}}
            items.insert(0, row)
            by_id[it["id"]] = row
    inputs_by_id = {it["id"]: it for it in inputs}

    # each model works through the stories it hasn't seen yet (so a newly added model catches up)
    for model in MODELS:
        todo = [inputs_by_id[x["id"]] for x in items
                if x["id"] in inputs_by_id and model not in x["locals"]][:N]
        if todo:
            run_model(model, todo, by_id)
        else:
            print(f"[compare] {model}: nothing new to compare")

    items = [x for x in items if x["locals"]][:KEEP]
    order = {m: i for i, m in enumerate(MODELS)}
    all_models = sorted({m for x in items for m in x["locals"]}, key=lambda m: order.get(m, 99))
    api_model = next((x["api"].get("model") for x in items if x["api"].get("model")), "gpt-oss-120b (Groq)")
    summary = {m: summarize_model(items, m) for m in all_models}
    OUT.write_text(json.dumps({
        "api_model": api_model, "local_models": all_models,
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "summary": summary, "items": items,
    }, indent=1, ensure_ascii=False), encoding="utf-8")
    for m, s in summary.items():
        print(f"[compare] {m}: {s}")


if __name__ == "__main__":
    main()
