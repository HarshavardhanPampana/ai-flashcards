import hashlib
import warnings

import feedparser
import requests
from urllib import robotparser
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup, MarkupResemblesLocatorWarning

from .config import USER_AGENT

warnings.filterwarnings("ignore", category=MarkupResemblesLocatorWarning)
HEADERS = {"User-Agent": USER_AGENT}


def make_item(title, url, source, published, text, category, extra=None):
    return {
        "id": hashlib.sha1(url.encode()).hexdigest()[:16],
        "title": " ".join((title or "").split()),
        "url": url,
        "source": source,
        "published": published or "",
        "text": " ".join(BeautifulSoup(text or "", "html.parser").get_text(" ").split())[:4000],
        "category": category,
        "extra": extra or {},
    }


def _parse_feed(url):
    # Fetch with requests (timeout + UA), then let feedparser parse the bytes.
    r = requests.get(url, headers=HEADERS, timeout=20)
    r.raise_for_status()
    return feedparser.parse(r.content)


def fetch_rss(src):
    feed = _parse_feed(src["url"])
    return [make_item(e.get("title"), e.get("link"), src["name"],
                      e.get("published", e.get("updated")), e.get("summary"), src["category"])
            for e in feed.entries[:30] if e.get("link")]


def fetch_arxiv(categories, n=60):
    q = "+OR+".join(f"cat:{c}" for c in categories)
    url = ("https://export.arxiv.org/api/query?search_query=" + q +
           f"&sortBy=submittedDate&sortOrder=descending&max_results={n}")
    feed = _parse_feed(url)
    return [make_item(e.title, e.link, "arXiv", e.get("published"), e.get("summary"), "paper")
            for e in feed.entries]


def fetch_hf_daily():
    r = requests.get("https://huggingface.co/api/daily_papers", headers=HEADERS, timeout=20)
    r.raise_for_status()
    out = []
    for d in r.json():
        paper = d.get("paper", {})
        if not paper.get("id"):
            continue
        url = f"https://huggingface.co/papers/{paper['id']}"
        out.append(make_item(paper.get("title"), url, "HF Daily Papers", d.get("publishedAt"),
                             paper.get("summary"), "paper", {"upvotes": paper.get("upvotes", 0)}))
    return out


def fetch_hn(keywords, min_points=80):
    r = requests.get("https://hn.algolia.com/api/v1/search",
                     params={"tags": "front_page", "hitsPerPage": 50}, headers=HEADERS, timeout=20)
    r.raise_for_status()
    out = []
    for h in r.json()["hits"]:
        title = (h.get("title") or "").lower()
        if (h.get("points") or 0) >= min_points and any(k in title for k in keywords):
            url = h.get("url") or f"https://news.ycombinator.com/item?id={h['objectID']}"
            out.append(make_item(h["title"], url, "Hacker News", h.get("created_at"), "",
                                 "community", {"points": h.get("points", 0)}))
    return out


def allowed_by_robots(url):
    base = f"{urlparse(url).scheme}://{urlparse(url).netloc}"
    rp = robotparser.RobotFileParser(base + "/robots.txt")
    try:
        rp.read()
        return rp.can_fetch(USER_AGENT, url)
    except Exception:
        return False


def fetch_html_list(name, page_url, link_selector, category="company"):
    """Fallback for sites with no feed. Inspect the page in DevTools to find link_selector."""
    if not allowed_by_robots(page_url):
        print(f"[skip] robots.txt disallows {page_url}")
        return []
    html = requests.get(page_url, headers=HEADERS, timeout=20).text
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for a in soup.select(link_selector)[:20]:
        url = urljoin(page_url, a.get("href", ""))
        out.append(make_item(a.get_text(" ", strip=True), url, name, "", "", category))
    return out


def fetch_page_text(url, limit=3000):
    """For items with no body text (e.g. Hacker News): grab the page's <p> text."""
    if not allowed_by_robots(url):
        return ""
    r = requests.get(url, headers=HEADERS, timeout=15)
    if "html" not in r.headers.get("content-type", ""):
        return ""
    soup = BeautifulSoup(r.text, "html.parser")
    text = " ".join(p.get_text(" ", strip=True) for p in soup.find_all("p"))
    return " ".join(text.split())[:limit]
