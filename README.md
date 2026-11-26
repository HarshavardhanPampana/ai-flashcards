# AI News Flashcards

A self-updating study deck of AI news, powered by **five kinds of AI models** and running entirely on free
infrastructure. Every few hours GitHub Actions scans about 300 new stories from 14 sources, removes duplicates
(by text *and* by meaning), predicts which ones matter, has an LLM write flashcards, illustrates the top ones with
a diffusion model, and publishes everything to a static site on GitHub Pages.

**Live:** https://harshavardhanpampana.github.io/ai-flashcards/ · **How it works:** [`/about.html`](docs/about.html)

| Model family | Model | What it does here |
|---|---|---|
| **Encoder Transformer** | all-MiniLM-L6-v2 (22M params, fastembed/ONNX; transformers.js in the browser) | Semantic dedupe, related cards, search by meaning |
| **Feedforward network** | MLP 384→128→classes (scikit-learn) | Predicts stars and category *before* the LLM; ranking uses it |
| **LLM / Decoder Transformer** | gpt-oss-120b via Groq (Qwen, Gemini as automatic fallbacks) | Writes each card as strict JSON |
| **Local decoders** | Qwen2.5-0.5B and 1.5B-Instruct (transformers, CPU) | Weekly head-to-head against the 120B API model |
| **Diffusion model** | SD-Turbo (1-step Stable Diffusion, diffusers, CPU) | Cover images for the most important cards |

## Pipeline

```
fetch (RSS + APIs) ─▶ fuzzy dedupe ─▶ [Encoder] semantic dedupe ─▶ [FNN] MLP predicts stars/category
   ─▶ rank top 40 ─▶ [LLM] write cards ─▶ [Encoder] embed + related cards ─▶ cards.json / embeddings.json / stats.json
                                                     └▶ (next job) [Diffusion] cover images ─▶ img/*.webp
weekly: [Local decoders] Qwen 0.5B and 1.5B vs gpt-oss-120b on the same inputs ─▶ compare.json
```

| Workflow | When | What |
|---|---|---|
| `update-flashcards` | every 6 h (GitHub runs it ~2×/day in practice) | fetch → ML → LLM → commit |
| `generate-images` | after each successful update | SD-Turbo images for up to 8 new top cards |
| `compare-models` | Mondays + on demand | 0.5B and 1.5B local decoders vs API model (15 new stories each per run, results accumulate) |
| `tests` | every push | 12 unit tests (`pytest`) |

## Results (measured on real data)

- **MLP vs LLM:** on a held-out 20% of ~980 cards, the MLP matches the LLM's category **80%** of the time
  (always-guess-most-common: 56%), its stars are exact **76%** and within ±1 **98%**. It has ~50K weights, about
  2 million times smaller than the LLM, and trains in about 5 s.
- **Semantic dedupe:** tuned on 131 stories with known matches (`python -m eval.dedupe_eval`). At cosine ≥ 0.80 it
  catches 87% of true duplicates and flags ~2% of other stories. Its value is cross-outlet duplicates, the same
  story in different words, which fuzzy title matching cannot catch.
- **Local 0.5B vs 120B decoder:** the small model writes valid card JSON about ⅔ of the time at ~9 tokens/s on CPU, and
  mostly disagrees on category and stars. Model size matters a lot for reliable structured output.
- **Diffusion on CPU:** ~13–17 s per 512×512 image with 1 step; ~22 KB WebP each.
- **Reliability:** the LLM step paces itself to free-tier limits, falls back across models and providers, and validates
  JSON. 50+ scheduled runs succeeded in a row.

## Local setup
```bash
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env            # then add your Groq key (console.groq.com) and/or Gemini key (aistudio.google.com)
```
For images and the model comparison, also:
```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements-gen.txt
```

| Command | What it does |
|---|---|
| `python -m scraper.main` | Full pipeline: fetch, dedupe, ML, LLM, write `docs/*.json` |
| `python -m scraper.main --no-llm` / `--no-ml` | Test without the LLM / without the encoder and MLP |
| `python -m gen.images` | Diffusion cover images (`IMAGES_PER_RUN`, default 8) |
| `python -m gen.compare` | Local decoder vs API comparison (`COMPARE_N`, `LOCAL_MODEL`) |
| `python -m eval.dedupe_eval` | Measure semantic vs fuzzy dedupe on live data |
| `python -m pytest -q` | Unit tests |
| `python -m http.server 8000 --directory docs` | Preview the site at http://localhost:8000 |

Environment variables: `GROQ_API_KEY`, `GEMINI_API_KEY` (at least one), `GROQ_MODEL` / `LLM_MODEL` (optional:
force a model; blank = auto-pick from what your key can use), `LLM_ORDER` (default `groq,gemini`),
`MAX_CARDS_PER_RUN` (default 40). The site keeps the newest 1,000 cards from the last 14 days.

## Sources
OpenAI, Google DeepMind, Google AI, Microsoft Research, NVIDIA, Hugging Face blog, BAIR, TechCrunch AI, The Verge AI,
MIT Technology Review, Ars Technica (RSS) · arXiv cs.AI/LG/CL · HF Daily Papers · Hacker News (Algolia).
Edit `scraper/config.py` to change them. (r/MachineLearning was dropped: Reddit now blocks automated feed access.)

## Site features
- **Magazine layout:** the top story is a large hero card (with its key points on the front), and 4–5 star stories
  get wide feature cards; cards rise into view as you scroll
- **Living cards:** on desktop, cards tilt in 3D toward the cursor with a soft glare and image parallax, and the
  flip has a springy overshoot; on phones, cards press down. All motion is off with the reduced-motion setting.
- Flip cards (front: cover image, headline, TL;DR; back: key points, why it matters, related stories, and both the
  LLM's and the MLP's labels)
- **Search by meaning** (✨): your query is embedded *in the browser* with the same MiniLM encoder and matched
  against every card's vector, so "cheaper AI chips" finds stories that never use those words
- Category chips, time filter (All / New / Today / This week), importance, review status, sort
- **Pick mode** (`P`): swipe right to keep, left to skip, then study only your picks
- **Study mode** (`S`): one card at a time, Space flips, ← →, 1 = Got it, 2 = Review again; related stories jump in
- "How it works" page with live metrics from the pipeline
- **Sanzo Wada palette:** every colour is an exact colour from Sanzo Wada's *A Dictionary of Color Combinations*
  (values from [wada-sanzo-colors.com](https://www.wada-sanzo-colors.com/combinations/classic/all)). Light mode is
  Ivory Buff paper with Deep Lyons Blue (cf. combination #126); dark mode is a forest night of Deep Slate Green with
  Naples Yellow text and Coral Red (cf. #166).
  Each category has its own Wada colour, and every text colour passes WCAG AA. Shippori Mincho headlines.
- Light/dark, phone layout, add-to-home-screen; progress saved per browser

## Deploy
1. Public GitHub repo, push to `main`.
2. Settings → Secrets and variables → Actions: secret `GROQ_API_KEY` (and/or `GEMINI_API_KEY`).
3. Settings → Pages → Deploy from a branch → `main` / `/docs`.
4. Actions → update-flashcards → **Run workflow**. Images and comparisons follow automatically.

**Cost: $0.** GitHub Actions and Pages are free for public repos, Groq and Gemini have free tiers, and every model
runs on CPU. SD-Turbo's license allows personal, non-commercial use.

When you change `docs/style.css` or `docs/app.js`, bump the `?v=` number on their links in `docs/index.html`
(GitHub Pages lets browsers cache files for 10 minutes).
