# weight = how much you trust/care about the source (used in ranking)
RSS_SOURCES = [
    {"name": "OpenAI", "weight": 3.0, "category": "company",
     "url": "https://openai.com/news/rss.xml"},
    {"name": "Google DeepMind", "weight": 3.0, "category": "company",
     "url": "https://deepmind.google/blog/rss.xml"},
    {"name": "Google AI", "weight": 2.5, "category": "company",
     "url": "https://blog.google/technology/ai/rss/"},
    {"name": "Microsoft Research", "weight": 2.0, "category": "company",
     "url": "https://www.microsoft.com/en-us/research/feed/"},
    {"name": "NVIDIA", "weight": 2.0, "category": "company",
     "url": "https://blogs.nvidia.com/feed/"},
    {"name": "Hugging Face Blog", "weight": 2.0, "category": "company",
     "url": "https://huggingface.co/blog/feed.xml"},
    {"name": "TechCrunch AI", "weight": 2.0, "category": "news",
     "url": "https://techcrunch.com/category/artificial-intelligence/feed/"},
    {"name": "The Verge AI", "weight": 1.8, "category": "news",
     "url": "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"},
    {"name": "r/MachineLearning", "weight": 1.0, "category": "community",
     "url": "https://www.reddit.com/r/MachineLearning/.rss"},
]

ARXIV_CATEGORIES = ["cs.AI", "cs.LG", "cs.CL"]

KEYWORDS = ["llm", "model", "gpt", "claude", "gemini", "llama", "open-source", "benchmark",
            "agent", "reasoning", "multimodal", "release", "funding", "acquires", "launch",
            "transformer", "diffusion", "rlhf", "inference", "gpu", "chip"]

USER_AGENT = "ai-flashcards/1.0 (personal, non-commercial project)"
