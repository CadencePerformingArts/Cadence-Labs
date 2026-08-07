#!/usr/bin/env python3
"""Generate the Cadence Labs icon set (docs/icons/) — the cadence-bars mark in
the Labs color scheme, so the installed "Cadence Labs" app is visually
distinct from the original Cadence app.

To revert to the classic look later: set BG/BARS back to the classic values
below, rerun this script, and restore the matching SVG colors in
docs/index.html, docs/modes.html and scripts/gen_family_pages.py.

    pip install pillow && python3 scripts/gen_labs_logo.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

# Labs scheme: light blue field, yellow bars.
BG = "#339af0"
BARS = "#ffd43b"
# Classic scheme (the original app): BG = "#f0b429", BARS = "#16233d"

OUT = Path(__file__).resolve().parent.parent / "docs" / "icons"


def hx(s):
    s = s.lstrip("#")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4)) + (255,)


def draw(size: int, pad_frac: float = 0.0) -> Image.Image:
    ss = 4
    s = size * ss
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = s * pad_frac
    box = [pad, pad, s - pad, s - pad]
    radius = (box[2] - box[0]) * 0.23
    d.rounded_rectangle(box, radius=radius, fill=hx(BG))
    # four cadence bars, matching the site SVG geometry (viewBox 64):
    # x positions 16/27/38/49, y spans 26-38, 20-44, 28-36, 16-48, width ~6.5
    unit = (box[2] - box[0]) / 64.0
    ox = box[0]
    bars = [(16, 26, 38), (27, 20, 44), (38, 28, 36), (49, 16, 48)]
    w = 6.5 * unit
    for x, y1, y2 in bars:
        cx = ox + x * unit
        d.rounded_line = None  # PIL lacks rounded_line; emulate with line + circles
        d.line([(cx, ox + y1 * unit - box[0] + box[1]) if False else (cx, box[1] + y1 * unit),
                (cx, box[1] + y2 * unit)], fill=hx(BARS), width=int(w))
        r = w / 2
        for y in (y1, y2):
            cy = box[1] + y * unit
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=hx(BARS))
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    draw(192).save(OUT / "icon-192.png")
    draw(512).save(OUT / "icon-512.png")
    # maskable: mark shrunk into the safe zone on a full-bleed background
    m = Image.new("RGBA", (512, 512), hx(BG))
    mark = draw(400)
    m.alpha_composite(mark, (56, 56))
    m.save(OUT / "maskable-512.png")
    print(f"wrote Labs icons to {OUT} (bg {BG}, bars {BARS})")


if __name__ == "__main__":
    main()
