"""LLM -> flashcard JSON.

Providers are tried in LLM_ORDER (default "groq,gemini"); any without an API key is skipped.
Each provider picks its own model from the models the key can actually use (names change
often), moves on to the next model when one is overloaded or out of quota, and is switched
off for the rest of the run if it keeps failing.
"""
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


class FatalLLMError(Exception):
    """Bad key / permissions: this provider can't work this run."""


class ModelUnavailable(Exception):
    """This model is gone, overloaded or out of quota: try the provider's next model."""


class Provider:
    name = "?"
    env_key = ""
    env_model = ""
    min_interval = 0.0          # seconds between calls, to respect requests/minute
    max_fails = 2               # items in a row that fail completely -> switch provider off

    def __init__(self):
        self.client = None
        self.models = None
        self.idx = 0
        self.last_call = 0.0
        self.fails = 0
        self.disabled = False

    def available(self):
        return bool(os.environ.get(self.env_key)) and not self.disabled

    def model(self):
        if self.models is None:
            wanted = (os.environ.get(self.env_model) or "").strip().removeprefix("models/")
            try:
                names = self.list_models()
                ranked = self.rank(names)
                self.models = ([wanted] if wanted in names else []) + [m for m in ranked if m != wanted]
                if wanted and wanted not in names:
                    print(f"[{self.name}] {self.env_model}={wanted!r} not available")
            except FatalLLMError:
                raise
            except Exception as e:
                print(f"[{self.name}] could not list models ({str(e)[:100]})")
                self.models = [wanted] if wanted else self.fallback_models
            if not self.models:
                raise FatalLLMError(f"no usable {self.name} model found")
            print(f"[{self.name}] using model {self.models[0]}")
        if self.idx >= len(self.models):
            raise FatalLLMError(f"all {self.name} models unavailable")
        return self.models[self.idx]

    def next_model(self, why):
        old = self.models[self.idx] if self.models and self.idx < len(self.models) else "?"
        self.idx += 1
        if self.models and self.idx < len(self.models):
            print(f"[{self.name}] {old} {why}; switching to {self.models[self.idx]}")
        else:
            print(f"[{self.name}] {old} {why}; no more models, turning {self.name} off for this run")
            self.disabled = True

    def throttle(self):
        wait = self.min_interval - (time.time() - self.last_call)
        if wait > 0:
            time.sleep(wait)
        self.last_call = time.time()

    def generate(self, prompt):
        self.throttle()
        return _parse_json(self.call(self.model(), prompt))


class Groq(Provider):
    name, env_key, env_model = "groq", "GROQ_API_KEY", "GROQ_MODEL"
    min_interval = 2.5          # free tier is ~30 requests/minute
    fallback_models = ["llama-3.3-70b-versatile"]
    _skip = ("whisper", "tts", "guard", "embed", "playai", "distil", "compound", "orpheus", "vision")

    def _client(self):
        if self.client is None:
            from groq import Groq as G
            self.client = G(api_key=os.environ[self.env_key], max_retries=0)
        return self.client

    def list_models(self):
        import groq
        try:
            return [m.id for m in self._client().models.list().data]
        except (groq.AuthenticationError, groq.PermissionDeniedError) as e:
            raise FatalLLMError(f"groq key rejected: {str(e)[:120]}") from e

    def rank(self, names):
        def size(n):
            m = re.findall(r"(\d+)b\b", n.lower())
            return max(map(int, m)) if m else 0
        text = [n for n in names if not any(s in n.lower() for s in self._skip)]
        ok = [n for n in text if size(n) >= 8] or text   # prefer bigger models; else take any
        return sorted(ok, key=lambda n: ("versatile" in n, size(n)), reverse=True)[:4]

    def call(self, model, prompt):
        import groq
        try:
            r = self._client().chat.completions.create(
                model=model, temperature=0.2,
                response_format={"type": "json_object"},
                messages=[{"role": "user", "content": prompt}])
        except (groq.AuthenticationError, groq.PermissionDeniedError) as e:
            raise FatalLLMError(f"groq key rejected: {str(e)[:120]}") from e
        except groq.NotFoundError as e:
            raise ModelUnavailable("not found") from e
        except groq.RateLimitError as e:
            raise ModelUnavailable("rate limited") from e
        except groq.InternalServerError as e:
            raise ModelUnavailable(f"server error {e.status_code}") from e
        return r.choices[0].message.content


class Gemini(Provider):
    name, env_key, env_model = "gemini", "GEMINI_API_KEY", "LLM_MODEL"
    min_interval = 13.0         # free tier is ~5 requests/minute
    fallback_models = ["gemini-flash-latest", "gemini-flash-lite-latest"]
    _skip = ("image", "tts", "audio", "live", "embedding", "vision", "thinking-exp", "computer")

    def _client(self):
        if self.client is None:
            from google import genai
            self.client = genai.Client(api_key=os.environ[self.env_key])
        return self.client

    def list_models(self):
        return [m.name.removeprefix("models/") for m in self._client().models.list()
                if "generateContent" in (m.supported_actions or [])]

    def rank(self, names):
        flash = [n for n in names if "flash" in n and not any(s in n for s in self._skip)]

        def key(n):
            v = re.search(r"gemini-(\d+)(?:\.(\d+))?", n)
            ver = (int(v.group(1)), int(v.group(2) or 0)) if v else (0, 0)
            return (n.endswith("-latest"), "preview" not in n and "exp" not in n,
                    "lite" not in n, ver, -len(n))
        # each model has its own free quota, so keep a few to fall back on
        return sorted(flash, key=key, reverse=True)[:5]

    def call(self, model, prompt):
        from google.genai import errors
        try:
            resp = self._client().models.generate_content(
                model=model, contents=prompt,
                config={"response_mime_type": "application/json", "temperature": 0.2})
        except errors.ClientError as e:
            if e.code in (401, 403) or (e.code == 400 and "API_KEY" in str(e)):
                raise FatalLLMError(f"gemini key rejected: {str(e)[:120]}") from e
            if e.code in (404, 429):
                raise ModelUnavailable("not found" if e.code == 404 else "out of quota") from e
            raise
        except errors.ServerError as e:
            raise ModelUnavailable(f"overloaded ({e.code})") from e
        return resp.text


PROVIDERS = {"groq": Groq(), "gemini": Gemini()}


def _active():
    order = os.environ.get("LLM_ORDER", "groq,gemini")
    return [PROVIDERS[n.strip()] for n in order.split(",")
            if n.strip() in PROVIDERS and PROVIDERS[n.strip()].available()]


def llm_available():
    return bool(_active())


def _parse_json(text):
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)   # strip code fences
    m = re.search(r"\{.*\}", text, re.S)
    return json.loads(m.group(0) if m else text)


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


def summarize(item, retries=2):
    short = len(item["text"]) < 200
    prompt = PROMPT.format(source=item["source"], title=item["title"],
                           text=item["text"][:3000] or "(none)",
                           title_only_note=TITLE_ONLY_NOTE if short else "")
    title = item["title"][:50]
    for p in _active():
        tries = 0
        while p.available() and tries <= retries:
            try:
                card = _clean(p.generate(prompt))
                if not card["headline"]:
                    raise ValueError("empty headline")
                card.update({"id": item["id"], "url": item["url"],
                             "source": item["source"], "date": item["published"]})
                p.fails = 0
                return card
            except FatalLLMError as e:
                print(f"[{p.name}] {e}; turning {p.name} off for this run")
                p.disabled = True
            except ModelUnavailable as e:
                tries += 1
                if tries <= retries:
                    print(f"[{p.name}] {title} -> {e}; waiting {5 * tries}s")
                    time.sleep(5 * tries)
                else:
                    p.next_model(str(e))
                    tries = 0
                    if p.available():
                        continue
            except Exception as e:      # bad JSON etc.: retry this item a couple of times
                tries += 1
                print(f"[{p.name}] {title} -> {str(e)[:120]}")
        if not p.disabled:
            p.fails += 1
            if p.fails >= p.max_fails:
                print(f"[{p.name}] {p.fails} items in a row failed; turning {p.name} off for this run")
                p.disabled = True
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
