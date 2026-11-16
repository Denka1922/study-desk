#!/usr/bin/env python3
"""Draw all icon files from scripts/icon.svg and scripts/icon-foreground.svg.

    python3 scripts/make-icons.py                  desktop/icon.png, desktop/icon.ico, mobile/assets/icon-only.png
    python3 scripts/make-icons.py --android RES    Android launcher icons into the given res/ folder

Dev-time script (needs Playwright's Chromium and Pillow). The outputs are committed.
"""
import argparse
import io
import sys
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BACKGROUND = "#2540D9"

DENSITY = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def render(svg_name: str, size: int) -> Image.Image:
    from playwright.sync_api import sync_playwright
    svg = (HERE / svg_name).read_text(encoding="utf-8")
    html = f"<html><body style='margin:0;background:transparent'>{svg.replace('width=\"1024\" height=\"1024\"', f'width=\"{size}\" height=\"{size}\"', 1)}</body></html>"
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": size, "height": size})
        pg.set_content(html)
        png = pg.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": size, "height": size})
        b.close()
    return Image.open(io.BytesIO(png)).convert("RGBA")


def desktop_and_mobile() -> None:
    big = render("icon.svg", 1024)
    (ROOT / "mobile" / "assets").mkdir(parents=True, exist_ok=True)
    big.save(ROOT / "mobile" / "assets" / "icon-only.png")
    big.resize((512, 512), Image.LANCZOS).save(ROOT / "desktop" / "icon.png")
    big.save(ROOT / "desktop" / "icon.ico",
             sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def circle(img: Image.Image) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, img.size[0] - 1, img.size[1] - 1), fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def android(res: Path) -> None:
    full = render("icon.svg", 1024)
    fg = render("icon-foreground.svg", 1024)
    for dens, k in DENSITY.items():
        d = res / f"mipmap-{dens}"
        d.mkdir(parents=True, exist_ok=True)
        s = round(48 * k)
        full.resize((s, s), Image.LANCZOS).save(d / "ic_launcher.png")
        circle(full.resize((s, s), Image.LANCZOS)).save(d / "ic_launcher_round.png")
        f = round(108 * k)
        fg.resize((f, f), Image.LANCZOS).save(d / "ic_launcher_foreground.png")
    any26 = res / "mipmap-anydpi-v26"
    any26.mkdir(parents=True, exist_ok=True)
    xml = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
           '    <background android:drawable="@color/ic_launcher_background"/>\n'
           '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
           '</adaptive-icon>\n')
    (any26 / "ic_launcher.xml").write_text(xml)
    (any26 / "ic_launcher_round.xml").write_text(xml)
    # Capacitor's template ships its own vector launcher drawables and a Capacitor splash image: replace them.
    for stale in (res / "drawable" / "ic_launcher_background.xml", res / "drawable-v24" / "ic_launcher_foreground.xml"):
        if stale.exists():
            stale.unlink()
    for splash in sorted(res.glob("drawable*/splash.png")):
        w, h = Image.open(splash).size
        canvas = Image.new("RGBA", (w, h), BACKGROUND)
        side = round(min(w, h) * 0.30)
        glyph = full.resize((side, side), Image.LANCZOS)
        canvas.paste(glyph, ((w - side) // 2, (h - side) // 2), glyph)
        canvas.convert("RGB").save(splash)
    vals = res / "values"
    vals.mkdir(parents=True, exist_ok=True)
    (vals / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <color name="ic_launcher_background">{BACKGROUND}</color>\n</resources>\n')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--android", metavar="RES_DIR")
    a = ap.parse_args()
    if a.android:
        android(Path(a.android))
    else:
        desktop_and_mobile()
    return 0


if __name__ == "__main__":
    sys.exit(main())
