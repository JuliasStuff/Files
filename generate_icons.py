#!/usr/bin/env python3
"""
Generate Files PWA icons from icon.png.
Requires Pillow:  pip install Pillow

Run from the Files folder:  python generate_icons.py
"""
from PIL import Image
from pathlib import Path

SRC = Path(__file__).parent / "icon.png"
OUT_DIR = Path(__file__).parent

SIZES = {
    "favicon-32.png": 32,
    "icon-192.png": 192,
    "icon-512.png": 512,
    "apple-touch-icon.png": 180,
}

# Maskable icon needs ~10% safe-zone padding so the icon isn't clipped by
# Android's adaptive masks.
MASKABLE_OUT = "icon-512-maskable.png"
MASKABLE_SIZE = 512
MASKABLE_BG = (246, 243, 236, 255)


def main():
    if not SRC.exists():
        raise SystemExit(f"Source icon not found: {SRC}")
    src = Image.open(SRC).convert("RGBA")
    for name, size in SIZES.items():
        out = src.resize((size, size), Image.LANCZOS)
        out.save(OUT_DIR / name, "PNG")
        print(f"wrote {name} ({size}x{size})")

    # Maskable: paste resized icon onto a padded background.
    inner = int(MASKABLE_SIZE * 0.78)
    bg = Image.new("RGBA", (MASKABLE_SIZE, MASKABLE_SIZE), MASKABLE_BG)
    fg = src.resize((inner, inner), Image.LANCZOS)
    offset = (MASKABLE_SIZE - inner) // 2
    bg.paste(fg, (offset, offset), fg)
    bg.save(OUT_DIR / MASKABLE_OUT, "PNG")
    print(f"wrote {MASKABLE_OUT} ({MASKABLE_SIZE}x{MASKABLE_SIZE}, maskable)")


if __name__ == "__main__":
    main()
