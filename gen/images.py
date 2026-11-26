"""Diffusion model: generate a cover image for the most important new cards.

Runs SD-Turbo (a distilled Stable Diffusion model) on CPU in ONE denoising step, which is what
makes it practical on a free GitHub runner: about 5-15 s per image instead of minutes.

  python -m gen.images                # IMAGES_PER_RUN (default 8) cards without an image
  IMAGES_PER_RUN=2 python -m gen.images

Writes docs/img/<card id>.webp and docs/images.json, and deletes images of expired cards.
SD-Turbo's license allows personal, non-commercial use.
"""
import hashlib
import json
import os
import time
from pathlib import Path

CARDS = Path("docs/cards.json")
INDEX = Path("docs/images.json")
IMG_DIR = Path("docs/img")
MODEL = os.environ.get("IMAGE_MODEL", "stabilityai/sd-turbo")
PER_RUN = int(os.environ.get("IMAGES_PER_RUN", 8))
SIZE = (448, 280)          # card banner, 16:10

STYLE = {
    "model_release": "glowing neural network core, abstract AI brain",
    "paper": "abstract research diagram, geometric data shapes, scientific",
    "product": "sleek modern device and app interface shapes",
    "funding": "rising abstract growth bars, coins of light",
    "acquisition": "two abstract shapes merging together",
    "policy": "abstract scales of justice, government building silhouette",
    "hardware": "close-up of a glowing computer chip and circuits",
    "open_source": "interlocking open puzzle pieces, collaborative network",
    "other": "abstract futuristic technology landscape",
}


def prompt_for(card):
    hint = STYLE.get(card.get("category"), STYLE["other"])
    return (f"editorial illustration for a tech news article about {card['headline']}, {hint}, "
            "flat vector art, clean shapes, soft gradient background, vibrant colors, "
            "no text, no letters, no words, no logos")


def seed_for(card_id):
    return int(hashlib.sha1(card_id.encode()).hexdigest()[:8], 16)


def load_pipe():
    import torch
    from diffusers import AutoPipelineForText2Image
    torch.set_num_threads(max(1, os.cpu_count() or 1))
    pipe = AutoPipelineForText2Image.from_pretrained(MODEL, dtype=torch.float32)
    pipe.set_progress_bar_config(disable=True)
    return pipe.to("cpu")


def to_banner(img):
    """512x512 -> centre crop to 16:10 -> resize."""
    from PIL import Image
    w, h = img.size
    ch = int(w * SIZE[1] / SIZE[0])
    top = (h - ch) // 2
    return img.crop((0, top, w, top + ch)).resize(SIZE, Image.LANCZOS)


def main():
    import torch
    cards = json.loads(CARDS.read_text(encoding="utf-8"))
    index = json.loads(INDEX.read_text(encoding="utf-8")) if INDEX.exists() else {"images": {}}
    images = index.get("images", {})
    live = {c["id"] for c in cards}

    # 1) delete images of cards that expired
    for cid in [k for k in images if k not in live]:
        (IMG_DIR / f"{cid}.webp").unlink(missing_ok=True)
        del images[cid]

    # 2) most important, newest cards without an image
    todo = [c for c in cards if c["id"] not in images and not c.get("no_llm")]
    todo.sort(key=lambda c: (c.get("importance", 1), c.get("added", "")), reverse=True)
    todo = todo[:PER_RUN]
    print(f"[images] {len(images)} existing, generating {len(todo)} with {MODEL}")

    if todo:
        IMG_DIR.mkdir(parents=True, exist_ok=True)
        t = time.time()
        pipe = load_pipe()
        print(f"[images] model loaded in {time.time() - t:.1f}s")
        times = []
        for c in todo:
            t = time.time()
            out = pipe(prompt=prompt_for(c), num_inference_steps=1, guidance_scale=0.0,
                       height=512, width=512,
                       generator=torch.Generator("cpu").manual_seed(seed_for(c["id"]))).images[0]
            to_banner(out).save(IMG_DIR / f"{c['id']}.webp", "WEBP", quality=78, method=6)
            images[c["id"]] = f"img/{c['id']}.webp"
            times.append(time.time() - t)
            print(f"  [{len(times)}/{len(todo)}] {times[-1]:.1f}s  {c['headline'][:60]}")
        index["last_run"] = {"model": MODEL, "steps": 1, "generated": len(times),
                             "avg_seconds": round(sum(times) / len(times), 1),
                             "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    index["model"] = MODEL
    index["images"] = images
    INDEX.write_text(json.dumps(index, indent=1), encoding="utf-8")
    print(f"[images] done: {len(images)} images for {len(live)} cards")


if __name__ == "__main__":
    main()
