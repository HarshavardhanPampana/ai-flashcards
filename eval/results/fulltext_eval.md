# Full-text + fact-check test on cards from git history

- 1791 unique cards from 54 versions of `cards.json`; full text for 1262
- 5266 key points tested

| Compared against | Median similarity | |
|---|---|---|
| Its own article | 0.685 | 10th pct 0.477 |
| Most similar other story (hard) | 0.381 | 90th pct 0.551 |
| Random other story | 0.255 | 90th pct 0.381 |

| Threshold | Real points kept | Hard-control points rejected | Random points rejected |
|---|---|---|---|
| 0.30 | 98.7% | 23.3% | 68.5% |
| 0.35 | 97.3% | 39.8% | 83.4% |
| 0.40 | 95.4% | 56.6% | 92.6% |
| 0.45 | 92.5% | 71.3% | 97.1% |
| 0.50 | 87.9% | 82.0% | 98.8% |
| 0.55 | 81.0% | 89.8% | 99.6% |
| 0.60 | 71.9% | 94.3% | 99.9% |
| 0.65 | 59.5% | 97.2% | 99.9% |
| 0.70 | 45.6% | 98.7% | 100.0% |
| 0.75 | 31.7% | 99.4% | 100.0% |

| Site | Cards | Full text | Blocked by robots | Short/empty | Errors | Median chars |
|---|---|---|---|---|---|---|
| huggingface.co | 645 | 605 | 0 | 40 | 0 | 2629 |
| arxiv.org | 317 | 317 | 0 | 0 | 0 | 2253 |
| techcrunch.com | 213 | 0 | 213 | 0 | 0 | 0 |
| www.theverge.com | 128 | 128 | 0 | 0 | 0 | 2645 |
| www.reddit.com | 120 | 0 | 120 | 0 | 0 | 0 |
| openai.com | 98 | 0 | 98 | 0 | 0 | 0 |
| blogs.nvidia.com | 44 | 44 | 0 | 0 | 0 | 5338 |
| deepmind.google | 40 | 40 | 0 | 0 | 0 | 4588 |
| blog.google | 36 | 36 | 0 | 0 | 0 | 3223 |
| arstechnica.com | 20 | 0 | 20 | 0 | 0 | 0 |
| github.com | 17 | 16 | 0 | 1 | 0 | 5467 |
| www.microsoft.com | 14 | 14 | 0 | 0 | 0 | 6000 |
| www.technologyreview.com | 10 | 10 | 0 | 0 | 0 | 6000 |
| bair.berkeley.edu | 10 | 10 | 0 | 0 | 0 | 6000 |
