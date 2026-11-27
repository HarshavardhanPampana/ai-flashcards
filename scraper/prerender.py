"""Bake the top stories into docs/index.html so the page has real content without JavaScript.

Link previews (LinkedIn, Slack, iMessage) and simple crawlers don't run JavaScript, so they used to see
only "Loading…". This writes, between marker comments:
  - in <head>: description + Open Graph / Twitter tags built from the newest top stories
  - in <main id="grid">: the top 5 stories as plain HTML (app.js replaces them once it loads)

run: python -m scraper.prerender      (the update and image workflows run it after each update)
"""
import html
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

DOCS = Path("docs")
INDEX = DOCS / "index.html"
SITE = "https://harshavardhanpampana.github.io/ai-flashcards/"
TOP = 5


def top_cards(cards, n=TOP, hours=48):
    """Most important recent stories: last `hours` first (fall back to all), then stars, then newest."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    real = [c for c in cards if not c.get("no_llm")]
    recent = [c for c in real if c.get("added", "") >= cutoff] or real
    recent.sort(key=lambda c: (c.get("importance", 0), c.get("added", "")), reverse=True)
    return recent[:n]


def _e(s):
    return html.escape(str(s or ""), quote=True)


def head_block(cards):
    lead = cards[0]["headline"] if cards else "The latest AI research, model releases and industry news"
    desc = ("Today: " + " · ".join(c["headline"] for c in cards[:3])) if cards else \
        "Self-updating flashcards of the latest AI research, model releases and industry news."
    desc = desc if len(desc) <= 290 else desc[:287].rsplit(" ", 1)[0] + "…"
    tags = [
        f'<meta name="description" content="{_e(desc)}">',
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="AI News Flashcards">',
        f'<meta property="og:url" content="{SITE}">',
        f'<meta property="og:title" content="AI News Flashcards · {_e(lead)}">',
        f'<meta property="og:description" content="{_e(desc)}">',
        f'<meta property="og:image" content="{SITE}og.png">',
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        '<meta name="twitter:card" content="summary_large_image">',
        f'<link rel="canonical" href="{SITE}">',
    ]
    return "\n  ".join(tags)


def body_block(cards):
    items = []
    for c in cards:
        stars = "★" * int(c.get("importance", 0) or 0)
        items.append(
            f'<article class="seo-card"><p class="seo-meta">{_e(c.get("source"))} · {_e(c.get("category"))}'
            f' · <span aria-label="{int(c.get("importance", 0) or 0)} of 5">{stars}</span></p>'
            f'<h2><a href="{_e(c.get("url"))}" rel="noopener">{_e(c.get("headline"))}</a></h2>'
            f'<p>{_e(c.get("tldr"))}</p></article>')
    if not items:
        return '<p class="seo-note">Loading…</p>'
    return ('<section class="seo-top" aria-label="Top stories"><p class="seo-note">Top stories right now '
            '(the full interactive deck loads with JavaScript):</p>\n    ' + "\n    ".join(items) + "\n  </section>")


def replace_between(text, name, content):
    pat = re.compile(rf"(<!-- {name}:start -->)(.*?)(<!-- {name}:end -->)", re.S)
    if not pat.search(text):
        raise ValueError(f"markers for {name} not found in {INDEX}")
    return pat.sub(lambda m: m.group(1) + "\n  " + content + "\n  " + m.group(3), text, count=1)


def render(index_html, cards):
    top = top_cards(cards)
    out = replace_between(index_html, "prerender-head", head_block(top))
    return replace_between(out, "prerender-body", body_block(top))


def main():
    cards = json.loads((DOCS / "cards.json").read_text(encoding="utf-8"))
    text = INDEX.read_text(encoding="utf-8")
    new = render(text, cards)
    if new != text:
        INDEX.write_text(new, encoding="utf-8", newline="\n")
        print(f"[prerender] baked {min(TOP, len(cards))} stories into {INDEX}")
    else:
        print("[prerender] index.html already up to date")


if __name__ == "__main__":
    main()
