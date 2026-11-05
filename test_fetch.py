# run: python test_fetch.py   (Phase 1 check: no LLM, just prints fetched items)
from collections import Counter

from scraper.main import collect

items = collect()
print(len(items), "items from", len({i["source"] for i in items}), "sources")
print(Counter(i["source"] for i in items))
for it in items[:15]:
    print(f"[{it['source']}] {it['title']}")
