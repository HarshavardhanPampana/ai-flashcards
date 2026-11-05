# AI News Flashcards

Free, self-updating AI/tech news flashcards. GitHub Actions scrapes RSS feeds and APIs every 6 hours,
summarizes the top items with a free LLM (Groq first, Gemini as backup) and commits `docs/cards.json`.
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
copy .env.example .env            # then add your Groq key (console.groq.com) and/or Gemini key (aistudio.google.com)
```

| Command | What it does |
|---|---|
| `python test_fetch.py` | Fetch only. Prints counts per source (no LLM) |
| `python -m scraper.main` | Full pipeline: fetch, dedupe, rank, summarize, write `docs/cards.json` |
| `python -m scraper.main --no-llm` | Plain cards without an LLM, for testing the site. Doesn't mark items as seen; real runs replace these cards |
| `python -m http.server 8000 --directory docs` | Preview the site at http://localhost:8000 |

Environment variables: `GROQ_API_KEY`, `GEMINI_API_KEY` (at least one), `GROQ_MODEL` / `LLM_MODEL` (optional:
force a model; blank = auto-pick from what your key can use), `LLM_ORDER` (default `groq,gemini`),
`MAX_CARDS_PER_RUN` (default 40).

How the LLM step copes with free tiers: each provider paces itself to its per-minute limit, moves to its
next model when one is overloaded or out of quota (each model has its own free quota), and is switched off
for the rest of the run if it keeps failing. After 3 failed cards in a row the run stops without marking
those items as seen, so they're retried next time.

## Deploy
1. Create a **public** GitHub repo `ai-flashcards` and push this folder to `main`.
2. Settings → Secrets and variables → Actions:
   - Secret `GROQ_API_KEY` (main) and/or `GEMINI_API_KEY` (backup)
   - Optional variables `GROQ_MODEL` / `LLM_MODEL` to force a specific model (otherwise one is picked automatically)
3. Settings → Pages → Deploy from a branch → `main` / `/docs`.
4. Actions → update-flashcards → **Run workflow** to test it. After that it runs every 6 hours.

Site: `https://<username>.github.io/ai-flashcards/`

## Budget
4 runs/day × 40 cards = 160 LLM calls/day (about 1.2K tokens each). Groq's free tier (about 1,000
requests/day per model) covers this. Gemini's free tier can be as low as 20 requests/day, so it works only
as a backup. Check your real limits in each provider's console and lower `MAX_CARDS_PER_RUN` if needed.

## Site features
- Click a card to flip it: the front has the headline and TL;DR, the back has key points and why it matters
- Color-coded category chips, a time filter (All / New since your last visit / Today / This week),
  importance, review status and sort
- Search across headlines, summaries, companies and tags (press `/`)
- **Pick mode** (press `P`): swipe through cards like a deck. Right (or →) keeps a card, left (or ←) skips it,
  Z undoes, and a tap peeks at the back. Then "Study my picks", or filter the grid by **♥ My picks**.
- **Study mode** (press `S`): one card at a time. Space flips, ← → move, 1 = Got it, 2 = Review again,
  swipe on a phone. Cards marked "Review again" come first.
- Light/dark toggle, and it can be added to a phone home screen
- Progress ("Got it" / "Review again"), filters and theme are saved per browser in localStorage

When you change `docs/style.css` or `docs/app.js`, bump the `?v=` number on their links in
`docs/index.html`. GitHub Pages lets browsers cache files for 10 minutes, so without the bump a returning
visitor can get the new page with the old script.
