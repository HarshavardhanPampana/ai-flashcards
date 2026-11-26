"""Decoder comparison: the same story, summarized by a small LOCAL decoder vs the big API model.

The live site uses gpt-oss-120b through Groq. This script runs a ~0.5B-parameter open decoder
(Qwen2.5-0.5B-Instruct by default) on your own CPU with Hugging Face transformers, gives it the
exact same prompt and input, and measures:
  - does it return valid JSON in the card format?
  - how long does it take on CPU?
  - does it agree with the big model on category and importance?
  - how similar are the two TL;DRs in meaning? (encoder cosine similarity)

  python -m gen.compare               # COMPARE_N (default 5) recent stories not compared yet
Writes docs/compare.json, shown on the site's "How it works" page.
"""
import json
import os
import time
from pathlib import Path

from scraper.summarize import PROMPT, TITLE_ONLY_NOTE, _clean, _parse_json

INPUTS = Path("data/compare_inputs.json")
CARDS = Path("docs/cards.json")
OUT = Path("docs/compare.json")
MODEL = os.environ.get("LOCAL_MODEL", "Qwen/Qwen2.5-0.5B-Instruct")
N = int(os.environ.get("COMPARE_N", 5))
KEEP = 20


def build_prompt(it):
    short = len(it["text"]) < 200
    return PROMPT.format(source=it["source"], title=it["title"], text=it["text"][:2500] or "(none)",
                         title_only_note=TITLE_ONLY_NOTE if short else "")


def load_model():
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    torch.set_num_threads(max(1, os.cpu_count() or 1))
    tok = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32)
    model.eval()
    return tok, model


def generate(tok, model, prompt, max_new_tokens=520):
    import torch
    msgs = [{"role": "user", "content": prompt}]
    ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt")
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


def summarize_results(items):
    ok = [x for x in items if x["local"]["valid_json"]]
    n = len(items)
    agree = lambda f: round(sum(f(x) for x in ok) / len(ok), 3) if ok else None
    sims = [x["tldr_similarity"] for x in ok if x.get("tldr_similarity") is not None]
    return {
        "n": n,
        "json_valid_rate": round(len(ok) / n, 3) if n else None,
        "avg_seconds_local": round(sum(x["local"]["seconds"] for x in items) / n, 1) if n else None,
        "avg_tokens_per_second": round(sum(x["local"]["tokens_per_second"] for x in items) / n, 1) if n else None,
        "category_agreement": agree(lambda x: x["local"]["card"]["category"] == x["api"]["category"]),
        "importance_within_1": agree(lambda x: abs(x["local"]["card"]["importance"] - x["api"]["importance"]) <= 1),
        "avg_tldr_similarity": round(sum(sims) / len(sims), 3) if sims else None,
    }


def main():
    inputs = json.loads(INPUTS.read_text(encoding="utf-8")) if INPUTS.exists() else []
    cards = {c["id"]: c for c in json.loads(CARDS.read_text(encoding="utf-8"))}
    prev = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"items": []}
    done = {x["id"] for x in prev["items"]}
    todo = [it for it in inputs if it["id"] in cards and it["id"] not in done][:N]
    print(f"[compare] {len(todo)} stories to compare with {MODEL}")
    if not todo:
        return

    t = time.time()
    tok, model = load_model()
    print(f"[compare] model loaded in {time.time() - t:.1f}s")
    new = []
    for i, it in enumerate(todo, 1):
        text, secs, ntok = generate(tok, model, build_prompt(it))
        try:
            local_card, valid = _clean(_parse_json(text)), True
            if not local_card["headline"]:
                valid = False
        except Exception:
            local_card, valid = {"headline": "", "tldr": "", "key_points": [], "why_it_matters": "",
                                 "category": "other", "importance": 1, "tags": [], "companies": []}, False
        api = cards[it["id"]]
        row = {
            "id": it["id"], "title": it["title"], "source": it["source"], "url": it["url"],
            "api": {k: api.get(k) for k in ("headline", "tldr", "key_points", "why_it_matters",
                                            "category", "importance", "model")},
            "local": {"card": local_card, "valid_json": valid, "seconds": round(secs, 1),
                      "tokens": ntok, "tokens_per_second": round(ntok / max(secs, 1e-6), 1),
                      "raw": None if valid else text[:400]},
            "tldr_similarity": tldr_similarity(api.get("tldr", ""), local_card.get("tldr", "")) if valid else None,
        }
        new.append(row)
        print(f"  [{i}/{len(todo)}] {secs:.0f}s valid={valid} cat {local_card['category']} vs {api['category']}"
              f"  | {it['title'][:50]}")

    items = (new + prev["items"])[:KEEP]
    OUT.write_text(json.dumps({"local_model": MODEL, "api_model": next(
        (x["api"].get("model") for x in items if x["api"].get("model")), "gpt-oss-120b (Groq)"),
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "summary": summarize_results(items), "items": items}, indent=1, ensure_ascii=False), encoding="utf-8")
    print("[compare] summary:", summarize_results(items))


if __name__ == "__main__":
    main()
