# run: python -m scraper.main            (needs GEMINI_API_KEY or GROQ_API_KEY)
#      python -m scraper.main --no-llm   (local test: plain cards, nothing marked as seen)
import argparse
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from .config import RSS_SOURCES, ARXIV_CATEGORIES, KEYWORDS
from . import fetchers as f
from .dedupe import load_seen, save_seen, dedupe
from .rank import top_n, score
from .summarize import summarize, basic_card, llm_available

CARDS = Path("docs/cards.json")
MAX_CARDS = int(os.environ.get("MAX_CARDS_PER_RUN", 40))
KEEP_DAYS = 14
MAX_CARDS_TOTAL = 1000   # keeps cards.json small and the site fast
MAX_FAILS_IN_A_ROW = 3
SLEEP_BETWEEN_CALLS = float(os.environ.get("SLEEP_BETWEEN_CALLS", 0))  # extra pause; providers pace themselves


def safe(fn, *a):
    try:
        return fn(*a)
    except Exception as e:
        print(f"[source error] {fn.__name__}{'(' + a[0]['name'] + ')' if a and isinstance(a[0], dict) else ''}: {e}")
        return []


def collect():
    items = []
    for s in RSS_SOURCES:
        got = safe(f.fetch_rss, s)
        print(f"  {s['name']}: {len(got)}")
        items += got
    for name, fn, args in (("arXiv", f.fetch_arxiv, (ARXIV_CATEGORIES,)),
                           ("HF Daily Papers", f.fetch_hf_daily, ()),
                           ("Hacker News", f.fetch_hn, (KEYWORDS,))):
        got = safe(fn, *args)
        print(f"  {name}: {len(got)}")
        items += got
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true", help="build plain cards without an LLM")
    ap.add_argument("--max", type=int, default=MAX_CARDS)
    args = ap.parse_args()

    use_llm = not args.no_llm
    if use_llm and not llm_available():
        raise SystemExit("No GEMINI_API_KEY or GROQ_API_KEY set. Add one to .env, "
                         "or run with --no-llm to test without an LLM.")

    old = json.loads(CARDS.read_text(encoding="utf-8")) if CARDS.exists() else []
    seen = load_seen()
    print("fetching...")
    items = sorted(collect(), key=score, reverse=True)
    # also fuzzy-dedupe against headlines of real cards already on the site
    fresh = dedupe(items, seen if use_llm else [],
                   existing_titles=[c.get("headline", "") for c in old if not c.get("no_llm")])
    picked = top_n(fresh, args.max)
    print(f"collected={len(items)} fresh={len(fresh)} summarizing={len(picked)}")

    new_cards, streak, aborted = [], [], False
    for i, it in enumerate(picked, 1):
        if use_llm:
            if len(it["text"]) < 200 and it["source"] == "Hacker News":
                try:
                    it["text"] = f.fetch_page_text(it["url"])
                except Exception:
                    pass
            card = summarize(it)
            if card:
                # mark seen after attempting, so one-off failures don't loop forever
                seen.extend(streak + [it["id"]])
                streak = []
            else:
                streak.append(it["id"])
                if len(streak) >= MAX_FAILS_IN_A_ROW:
                    # likely a config problem (key/model/quota): stop, and leave these unseen
                    print(f"[abort] {len(streak)} LLM failures in a row - check your API keys "
                          "(GROQ_API_KEY / GEMINI_API_KEY) and free-tier quotas")
                    streak, aborted = [], True
                    break
            time.sleep(SLEEP_BETWEEN_CALLS)
        else:
            card = basic_card(it)
        if card:
            card["added"] = datetime.now(timezone.utc).isoformat()
            new_cards.append(card)
            print(f"  [{i}/{len(picked)}] {card['headline'][:70]}")

    cutoff = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).isoformat()
    new_ids = {c["id"] for c in new_cards}
    # real LLM cards replace any earlier --no-llm placeholder with the same id
    merged = new_cards + [c for c in old if c["id"] not in new_ids]
    cards = [c for c in merged if c.get("added", "") >= cutoff]
    cards.sort(key=lambda c: c.get("added", ""), reverse=True)
    cards = cards[:MAX_CARDS_TOTAL]
    CARDS.write_text(json.dumps(cards, indent=1, ensure_ascii=False), encoding="utf-8")
    if use_llm:
        save_seen(seen + streak)
    print(f"added {len(new_cards)} cards, total {len(cards)}")
    if aborted and not new_cards:
        raise SystemExit(1)   # make the Actions run show red


if __name__ == "__main__":
    main()
