"""GeoJSON -> optimize edilmiş SVG harita üreticisi.

Kullanım:
    uv run python tools/build_map.py <tr-cities.json>

Girdi: il sınırlarını içeren GeoJSON (properties.number = plaka kodu).
Örn. https://github.com/alpers/Turkey-Maps-GeoJSON (tr-cities.json)

Çıktılar:
    templates/_turkey_map.svg   -> index.html içine gömülen <svg>
    data/province_geo.json      -> plaka başına yüzölçümü (km²) ve merkez noktası
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SVG_OUT = ROOT / "templates" / "_turkey_map.svg"
GEO_OUT = ROOT / "data" / "province_geo.json"

WIDTH = 1000.0
PAD = 8.0
EPSILON = 0.28  # Douglas-Peucker toleransı (px)


def merc_y(lat: float) -> float:
    return math.degrees(math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def rdp(points: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    """İteratif Ramer-Douglas-Peucker sadeleştirme."""
    if len(points) < 4:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            if norm < 1e-9:  # kapalı halka: uç noktalar çakışık
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best:
                best, idx = d, i
        if best > eps and idx != -1:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]


def ring_area_km2(ring: list[list[float]]) -> float:
    """Yerel eşit-alan yaklaşık projeksiyonla halka alanı (km²)."""
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx = 111.320 * math.cos(math.radians(lat0))
    ky = 110.574
    s = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        s += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
    return abs(s) / 2


def polygons(geom: dict) -> list[list[list[list[float]]]]:
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    return geom["coordinates"]


def main(src: Path) -> None:
    data = json.loads(src.read_text(encoding="utf-8"))
    feats = data["features"]

    lons = [c[0] for f in feats for poly in polygons(f["geometry"]) for ring in poly for c in ring]
    lats = [c[1] for f in feats for poly in polygons(f["geometry"]) for ring in poly for c in ring]
    min_lon, max_lon = min(lons), max(lons)
    min_y, max_y = merc_y(min(lats)), merc_y(max(lats))
    scale = (WIDTH - 2 * PAD) / (max_lon - min_lon)
    height = (max_y - min_y) * scale + 2 * PAD

    def project(lon: float, lat: float) -> tuple[float, float]:
        return (lon - min_lon) * scale + PAD, (max_y - merc_y(lat)) * scale + PAD

    paths, geo = [], {}
    for f in sorted(feats, key=lambda f: int(f["properties"]["number"])):
        plate = f"TR-{int(f['properties']['number']):02d}"
        d_parts, area, best_area, centroid = [], 0.0, -1.0, (0.0, 0.0)
        for poly in polygons(f["geometry"]):
            outer = poly[0]
            a = ring_area_km2(outer) - sum(ring_area_km2(h) for h in poly[1:])
            area += a
            for ring in poly:
                pts = rdp([project(lon, lat) for lon, lat in ring], EPSILON)
                if len(pts) < 3:
                    continue
                d_parts.append(
                    "M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in pts) + "Z"
                )
            if a > best_area:
                best_area = a
                xs = [project(*c) for c in outer]
                centroid = (sum(p[0] for p in xs) / len(xs), sum(p[1] for p in xs) / len(xs))
        geo[plate] = {
            "area_km2": round(area),
            "cx": round(centroid[0], 1),
            "cy": round(centroid[1], 1),
        }
        paths.append(
            f'<path id="{plate}" class="province" data-plate="{plate}" '
            f'd="{"".join(d_parts)}"/>'
        )

    svg = (
        f'<svg id="turkey-map" class="map-svg" viewBox="0 0 {WIDTH:.0f} {height:.0f}" '
        f'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Türkiye il haritası" '
        f'preserveAspectRatio="xMidYMid meet">\n'
        f'<g id="map-viewport"><g id="provinces">\n' + "\n".join(paths) + "\n</g></g>\n</svg>\n"
    )
    SVG_OUT.parent.mkdir(parents=True, exist_ok=True)
    GEO_OUT.parent.mkdir(parents=True, exist_ok=True)
    SVG_OUT.write_text(svg, encoding="utf-8")
    GEO_OUT.write_text(json.dumps(geo, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(paths)} il yazıldı -> {SVG_OUT} ({SVG_OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]))
