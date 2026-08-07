#!/usr/bin/env python3
"""Generate the Cadence app icon set: the wordmark "C." — a bold gold C with a
gold dot — on the brand navy. Run from the repo root after changing brand
colors; outputs into apps/cadence/assets/images/.

    pip install pillow && python3 scripts/gen_app_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

NAVY = (10, 63, 107, 255)      # #0a3f6b
GOLD = (240, 180, 41, 255)     # #f0b429
WHITE = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "apps" / "cadence" / "assets" / "images"


def draw_mark(size: int, color, scale: float = 1.0) -> Image.Image:
    """The 'C.' mark on a transparent canvas, drawn at 4x and downsampled."""
    ss = 4
    s = size * ss
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = s * 0.46, s * 0.5
    r = s * 0.30 * scale
    stroke = s * 0.115 * scale
    # C: an arc with a mouth opening to the right.
    bbox = [cx - r, cy - r, cx + r, cy + r]
    d.arc(bbox, start=35, end=325, fill=color, width=int(stroke))
    # Round the arc ends.
    import math
    for ang in (35, 325):
        a = math.radians(ang)
        ex, ey = cx + r_mid(r, stroke) * math.cos(a), cy + r_mid(r, stroke) * math.sin(a)
        d.ellipse([ex - stroke / 2, ey - stroke / 2, ex + stroke / 2, ey + stroke / 2], fill=color)
    # The dot.
    dot_r = s * 0.075 * scale
    dx, dy = s * 0.80, cy + r - dot_r * 0.6
    d.ellipse([dx - dot_r, dy - dot_r, dx + dot_r, dy + dot_r], fill=color)
    return img.resize((size, size), Image.LANCZOS)


def r_mid(r: float, stroke: float) -> float:
    return r - stroke / 2


def on_navy(size: int, mark_scale: float = 1.0) -> Image.Image:
    img = Image.new("RGBA", (size, size), NAVY)
    img.alpha_composite(draw_mark(size, GOLD, mark_scale))
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    on_navy(1024).convert("RGB").save(OUT / "icon.png")
    draw_mark(1024, GOLD).save(OUT / "splash-icon.png")
    draw_mark(1024, GOLD, 0.72).save(OUT / "android-icon-foreground.png")
    Image.new("RGBA", (1024, 1024), NAVY).save(OUT / "android-icon-background.png")
    draw_mark(1024, WHITE, 0.72).save(OUT / "android-icon-monochrome.png")
    on_navy(48).convert("RGB").save(OUT / "favicon.png")
    print(f"wrote icon set to {OUT}")


if __name__ == "__main__":
    main()
