"""PWA ikonları ve sosyal paylaşım görseli (Open Graph) üretir.

Harita, templates/_turkey_map.svg içindeki path'lerden (yalnızca M/L/Z) çizilir ve
nüfusa göre kobalt rampasıyla boyanır.

Kullanım: uv run --with pillow --extra pipeline python tools/make_images.py
Çıktı: static/icons/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png, og.png
"""

from __future__ import annotations

import io
import json
import math
import re
import ssl
from pathlib import Path

import httpx
import truststore
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "static" / "icons"
GLAZE, COBALT, INK, INK2 = "#F3F5F4", "#1F4FA0", "#14213D", "#4A5872"
RAMP = ["#85a9eb", "#6691e2", "#4b7ad3", "#3664bd", "#264f9e", "#1d3d7b", "#162c57"]
FONT_URL = ("https://raw.githubusercontent.com/google/fonts/main/ofl/bricolagegrotesque/"
            "BricolageGrotesque%5Bopsz%2Cwdth%2Cwght%5D.ttf")
SS = 4  # süper örnekleme (kenar yumuşatma)


def star(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    """Logo: dört köşeli yıldız (index.html'deki SVG ile aynı oranlar)."""
    pts = []
    for i in range(8):
        a = math.pi / 4 * i - math.pi / 2
        rr = r if i % 2 == 0 else r * 0.33
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return pts


def icon(size: int, maskable: bool = False) -> Image.Image:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:  # güvenli bölge: içerik merkezdeki %80'lik dairede
        d.rectangle([0, 0, s, s], fill=COBALT)
        d.polygon(star(s / 2, s / 2, s * 0.30), fill=GLAZE)
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=COBALT)
        d.polygon(star(s / 2, s / 2, s * 0.38), fill=GLAZE)
    return img.resize((size, size), Image.LANCZOS)


def map_polygons() -> tuple[dict[str, list[list[tuple[float, float]]]], tuple[float, float]]:
    svg = (ROOT / "templates" / "_turkey_map.svg").read_text(encoding="utf-8")
    vb = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg)
    polys: dict[str, list[list[tuple[float, float]]]] = {}
    for code, d in re.findall(r'id="(TR-\d\d)"[^>]* d="([^"]+)"', svg):
        rings = []
        for ring in re.findall(r"M([^Z]+)Z", d):
            rings.append([tuple(map(float, p.split(","))) for p in ring.split("L")])
        polys[code] = rings
    return polys, (float(vb.group(1)), float(vb.group(2)))


def og_image(font_bytes: bytes) -> Image.Image:
    W, H = 1200, 630
    img = Image.new("RGB", (W * SS, H * SS), GLAZE)
    d = ImageDraw.Draw(img)
    fb = json.loads((ROOT / "data" / "fallback_turkey_data.json").read_text(encoding="utf-8"))
    pops = {c: p["population"] for c, p in fb["provinces"].items()}
    ordered = sorted(pops.values())
    breaks = [ordered[len(ordered) * i // 7] for i in range(1, 7)]

    polys, (vw, vh) = map_polygons()
    k = (W - 120) / vw * SS
    ox, oy = 60 * SS, (H - vh * (W - 120) / vw - 8) * SS  # harita alta yaslı, başlıkla çakışmaz
    for code, rings in polys.items():
        cls = sum(pops.get(code, 0) >= b for b in breaks)
        for ring in rings:
            d.polygon([(ox + x * k, oy + y * k) for x, y in ring], fill=RAMP[cls], outline=GLAZE, width=SS)

    def font(size: int, weight: int) -> ImageFont.FreeTypeFont:
        f = ImageFont.truetype(io.BytesIO(font_bytes), size * SS)
        # eksen sırası fonttan okunur (opsz/wdth/wght sırası sabit değil)
        want = {b"Weight": weight, b"Width": 100, b"Optical size": 72, b"Optical Size": 72}
        axes = f.get_variation_axes()
        f.set_variation_by_axes([
            min(max(want.get(a["name"], a["default"]), a["minimum"]), a["maximum"]) for a in axes
        ])
        return f

    d.polygon(star(60 * SS + 22 * SS, 62 * SS, 22 * SS), fill=COBALT)
    d.text((60 * SS + 56 * SS, 36 * SS), "Türkiye Nüfus Atlası", font=font(52, 700), fill=INK)
    total = sum(pops.values())
    year = fb["meta"]["metrics"].get("population", {}).get("year", "")
    sub = f"81 il, {total / 1e6:.1f} milyon kişi ({year}). Doğum, ölüm, göç ve yaş haritası.".replace(".", ",", 1)
    d.text((60 * SS, 112 * SS), sub, font=font(26, 500), fill=INK2)
    return img.resize((W, H), Image.LANCZOS)


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    icon(192).save(ICONS / "icon-192.png", optimize=True)
    icon(512).save(ICONS / "icon-512.png", optimize=True)
    icon(512, maskable=True).save(ICONS / "icon-maskable-512.png", optimize=True)
    icon(180, maskable=True).convert("RGB").save(ICONS / "apple-touch-icon.png", optimize=True)
    with httpx.Client(verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT), timeout=60) as c:
        font_bytes = c.get(FONT_URL).raise_for_status().content
    og_image(font_bytes).save(ICONS / "og.png", optimize=True)
    for f in sorted(ICONS.glob("*.png")):
        print(f"{f.name}: {f.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
