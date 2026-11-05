"""LLM -> flashcard JSON. Gemini first, Groq as optional fallback."""
import json
import os
import re
import time

CATEGORIES = {"model_release", "paper", "product", "funding", "acquisition",
              "policy", "hardware", "open_source", "other"}

PROMPT = """You turn AI/tech news into study flashcards.
Return ONLY a JSON object with keys:
headline, tldr, key_points (3-5 short strings), why_it_matters,
category (one of: model_release, paper, product, funding, acquisition,
policy, hardware, open_source, other), companies (list), tags (list, max 4),
importance (integer 1-5; 5 = major industry event, 1 = minor).
Use only facts present in the input. Do not invent numbers.
{title_only_note}
SOURCE: {source}
TITLE: {title}
TEXT: {text}
"""

TITLE_ONLY_NOTE = ("NOTE: there is little or no body text. Work from the title only, keep "
                   "key_points to what the title states, and give importance of at most 2.\n")

_gemini = None
_groq = None


def _gemini_client():
    global _gemini
    if _gemini is None and os.environ.get("GEMINI_API_KEY"):
        from google import genai
        _gemini = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    return _gemini


def _groq_client():
    global _groq
    if _groq is None and os.environ.get("GROQ_API_KEY"):
        from groq import Groq
        _groq = Groq(api_key=os.environ["GROQ_API_KEY"])
    return _groq


def llm_available():
    return bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GROQ_API_KEY"))


def _parse_json(text):
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)   # strip code fences
    m = re.search(r"\{.*\}", text, re.S)
    return json.loads(m.group(0) if m else text)


def _call_gemini(prompt):
    client = _gemini_client()
    model = os.environ.get("LLM_MODEL") or "gemini-2.5-flash"
    resp = client.models.generate_content(
        model=model, contents=prompt,
        config={"response_mime_type": "application/json", "temperature": 0.2})
    return _parse_json(resp.text)


def _call_groq(prompt):
    client = _groq_client()
    model = os.environ.get("GROQ_MODEL") or "llama-3.3-70b-versatile"
    r = client.chat.completions.create(
        model=model, temperature=0.2,
        response_format={"type": "json_object"},
        messages=[{"role": "user", "content": prompt}])
    return _parse_json(r.choices[0].message.content)


def _clean(card):
    """Coerce LLM output into the expected schema."""
    def as_list(v):
        return [str(x) for x in v] if isinstance(v, list) else ([str(v)] if v else [])
    try:
        imp = int(card.get("importance", 1))
    except (TypeError, ValueError):
        imp = 1
    cat = str(card.get("category", "other")).strip().lower()
    return {
        "headline": str(card.get("headline", "")).strip(),
        "tldr": str(card.get("tldr", "")).strip(),
        "key_points": as_list(card.get("key_points"))[:5],
        "why_it_matters": str(card.get("why_it_matters", "")).strip(),
        "category": cat if cat in CATEGORIES else "other",
        "companies": as_list(card.get("companies")),
        "tags": as_list(card.get("tags"))[:4],
        "importance": max(1, min(5, imp)),
    }


def summarize(item, retries=3):
    short = len(item["text"]) < 200
    prompt = PROMPT.format(source=item["source"], title=item["title"],
                           text=item["text"][:3000] or "(none)",
                           title_only_note=TITLE_ONLY_NOTE if short else "")
    backends = [b for b, ok in ((_call_gemini, _gemini_client()), (_call_groq, _groq_client())) if ok]
    for backend in backends:
        for attempt in range(retries):
            try:
                card = _clean(backend(prompt))
                if not card["headline"]:
                    raise ValueError("empty headline")
                card.update({"id": item["id"], "url": item["url"],
                             "source": item["source"], "date": item["published"]})
                return card
            except Exception as e:
                wait = 10 * (attempt + 1)
                print(f"[{backend.__name__} retry {attempt+1}] {item['title'][:50]} -> "
                      f"{str(e)[:120]}; sleeping {wait}s")
                time.sleep(wait)
    return None


def basic_card(item):
    """No-LLM card built straight from the source text (for local testing with --no-llm)."""
    text = item["text"]
    first = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)[0] if text else ""
    return {
        "id": item["id"], "headline": item["title"][:120], "tldr": first[:300],
        "key_points": [], "why_it_matters": "(no LLM summary - run with an API key)",
        "category": "paper" if item["category"] == "paper" else "other",
        "companies": [], "tags": [], "importance": 1,
        "url": item["url"], "source": item["source"], "date": item["published"],
        "no_llm": True,
    }
