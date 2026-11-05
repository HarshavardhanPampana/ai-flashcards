# AI News Flashcards

Free, self-updating AI/tech news flashcards. GitHub Actions scrapes RSS feeds and APIs every 6 hours,
summarizes the top items with a free LLM (Gemini, with Groq as a fallback) and commits `docs/cards.json`.
GitHub Pages serves `docs/`.

## Sources
OpenAI, Google DeepMind, Google AI, Microsoft Research, NVIDIA, Hugging Face blog, TechCrunch AI,
The Verge AI, r/MachineLearning (RSS) · arXiv cs.AI/LG/CL · HF Daily Papers · Hacker News (Algolia).
Edit `scraper/config.py` to add or remove sources. `fetchers.fetch_html_list` handles sites with no feed
and checks robots.txt first.

## Local setup
```bash
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env            # then put your Gemini key (from Google AI Studio) in .env
```

| Command | What it does |
|---|---|
| `python test_fetch.py` | Fetch only. Prints counts per source (no LLM) |
| `python -m scraper.main` | Full pipeline: fetch, dedupe, rank, summarize, write `docs/cards.json` |
| `python -m scraper.main --no-llm` | Plain cards without an LLM, for testing the site. Doesn't mark items as seen; real runs replace these cards |
| `python -m http.server 8000 --directory docs` | Preview the site at http://localhost:8000 |

Environment variables: `GEMINI_API_KEY`, `LLM_MODEL` (optional; blank = auto-pick an available Gemini Flash model), `GROQ_API_KEY`,
`GROQ_MODEL` (optional fallback), `MAX_CARDS_PER_RUN` (default 40), `SLEEP_BETWEEN_CALLS` (default 5 s).

## Deploy
1. Create a **public** GitHub repo `ai-flashcards` and push this folder to `main`.
2. Settings → Secrets and variables → Actions:
   - Secret `GEMINI_API_KEY` (and optionally `GROQ_API_KEY`)
   - Optional variable `LLM_MODEL` to force a specific model (otherwise one is picked automatically)
3. Settings → Pages → Deploy from a branch → `main` / `/docs`.
4. Actions → update-flashcards → **Run workflow** to test it. After that it runs every 6 hours.

Site: `https://<username>.github.io/ai-flashcards/`

## Budget
4 runs/day × 40 cards = 160 LLM calls/day. Keep that under about 70% of your provider's free daily limit.
Set `SLEEP_BETWEEN_CALLS` ≥ 60 / (requests-per-minute limit).

## Site features
Click a card to flip it. You can filter by category, importance and review status, and search the
text. "Got it" / "Review again" progress is saved in your browser's localStorage.
