#!/usr/bin/env python3
"""
Generate Files PWA icons (favicon, app icons, maskable, apple-touch).
Requires Pillow:  pip install Pillow

Run from the Files folder:  python generate_icons.py

A warm rounded-square in the app's amber accent, with a clean white folder
glyph centered. Maskable variant has extra safe-zone padding so Android's
adaptive masks don't clip the folder.
"""
from PIL import Image, ImageDraw
from pathlib import Path

OUT_DIR = Path(__file__).parent

# Palette (matches CSS variables)
BG_TOP    = (215, 145, 75)    # lighter amber for gradient top
BG_BOTTOM = (161, 109, 52)    # --accent-2
GLYPH     = (255, 255, 255)   # white folder

OUTPUTS = {
    "favicon-32.png": (32, False),
    "icon-192.png": (192, False),
    "icon-512.png": (512, False),
    "apple-touch-icon.png": (180, False),
    "icon-512-maskable.png": (512, True),
    "icon.png": (512, False),
}


def make_gradient(size, top, bottom):
    img = Image.new("RGB", (1, size), 0)
    for y in range(size):
        t = y / max(size - 1, 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        img.putpixel((0, y), (r, g, b))
    return img.resize((size, size))


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_folder(draw, cx, cy, w, h, color):
    left   = cx - w / 2
    right  = cx + w / 2
    top    = cy - h / 2
    bottom = cy + h / 2
    radius = h * 0.12

    tab_w   = w * 0.42
    tab_h   = h * 0.18

    # Tab (upper-left, with rounded top corners; bottom extends behind body)
    draw.rounded_rectangle(
        [left, top, left + tab_w, top + tab_h + radius * 2],
        radius=radius,
        fill=color,
    )

    # Body (main folder rectangle, slightly below the top of the tab)
    body_top = top + tab_h * 0.85
    draw.rounded_rectangle(
        [left, body_top, right, bottom],
        radius=radius,
        fill=color,
    )

    # Seam line near the top of the body to suggest the folder lip
    seam_y = body_top + h * 0.10
    seam_pad = w * 0.06
    draw.rounded_rectangle(
        [left + seam_pad, seam_y, right - seam_pad, seam_y + h * 0.025],
        radius=h * 0.015,
        fill=(255, 255, 255, 180),
    )


def make_icon(size, maskable):
    if maskable:
        # Maskable: solid amber to the edge so the adaptive mask shows amber.
        bg = Image.new("RGBA", (size, size), (191, 127, 64, 255))
    else:
        gradient = make_gradient(size, BG_TOP, BG_BOTTOM).convert("RGBA")
        radius = int(size * 0.22)
        mask = rounded_mask(size, radius)
        bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        bg.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(bg)

    # Maskable shrinks to ~62% so the adaptive mask doesn't clip the folder;
    # standard icons can use ~70% of the canvas.
    inner = 0.62 if maskable else 0.70
    fw = size * inner
    fh = fw * 0.78
    cx, cy = size / 2, size / 2 + size * 0.02
    draw_folder(draw, cx, cy, fw, fh, GLYPH)

    return bg


def main():
    for name, (size, maskable) in OUTPUTS.items():
        img = make_icon(size, maskable)
        img.save(OUT_DIR / name, "PNG")
        tag = " (maskable)" if maskable else ""
        print(f"wrote {name} ({size}x{size}){tag}")


if __name__ == "__main__":
    main()
