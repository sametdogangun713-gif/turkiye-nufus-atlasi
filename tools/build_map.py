"""GeoJSON -> optimize edilmiş SVG harita üreticisi.

Kullanım:
    uv run python tools/build_map.py <tr-cities.json> [countries-50m.json]

Girdiler:
    tr-cities.json      il sınırları (properties.number = plaka kodu).
                        https://github.com/alpers/Turkey-Maps-GeoJSON (Apache-2.0)
    countries-50m.json  isteğe bağlı; komşu ülkeler için Natural Earth TopoJSON
                        (kamu malı). https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json

Çıktılar:
    templates/_turkey_map.svg   -> index.html içine gömülen <svg>
    data/province_geo.json      -> plaka başına yüzölçümü (km²), merkez ve etiket noktası

İl koordinatları komşu ülke eklense de değişmez: projeksiyon Türkiye'nin sınır
kutusuna göre kurulur, komşular için yalnızca viewBox genişletilir.
"""

from __future__ import annotations

import heapq
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
NEIGHBOR_EPSILON = 0.5

# Görünen alan (boylam, enlem): komşuların sınır boyu görünecek kadar geniş
VIEW_LON = (24.3, 46.6)
VIEW_LAT = (34.5, 43.0)

# Natural Earth adı -> Türkçe etiket ve etiket noktası (boylam, enlem). Etiketi
# olmayan ülkeler (Kıbrıs, Lübnan, Rusya...) yalnızca şekil olarak çizilir.
NEIGHBORS = {
    "Greece": ("Yunanistan", 24.95, 41.2),
    "Bulgaria": ("Bulgaristan", 26.0, 42.55),
    "Georgia": ("Gürcistan", 43.4, 42.05),
    "Armenia": ("Ermenistan", 44.75, 40.45),
    "Azerbaijan": ("Azerbaycan", 46.05, 40.85),
    "Iran": ("İran", 45.75, 37.7),
    "Iraq": ("Irak", 43.4, 35.85),
    "Syria": ("Suriye", 38.6, 35.55),
}
# Azerbaycan'ın Nahçıvan parçası ayrıca etiketlenir
EXTRA_LABELS = [("country", "Nahçıvan", 45.35, 39.3)]
SEAS = [
    ("Karadeniz", 34.2, 42.55),
    ("Marmara Denizi", 28.15, 40.72),
    ("Ege Denizi", 25.35, 38.75),
    ("Akdeniz", 30.3, 35.45),
]


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


def ring_area_px(ring: list[tuple[float, float]]) -> float:
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))) / 2


def polygons(geom: dict) -> list[list[list[list[float]]]]:
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    return geom["coordinates"]


def path_d(rings: list[list[tuple[float, float]]]) -> str:
    return "".join("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in r) + "Z" for r in rings)


# ------------------------------------------------------------ Etiket noktası
def _point_to_rings_dist(x: float, y: float, rings: list[list[tuple[float, float]]]) -> float:
    """İşaretli uzaklık: içerideyse pozitif."""
    inside, best = False, math.inf
    for ring in rings:
        for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1]):
            if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
                inside = not inside
            dx, dy = bx - ax, by - ay
            t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
            best = min(best, math.hypot(x - ax - t * dx, y - ay - t * dy))
    return best if inside else -best


def polylabel(rings: list[list[tuple[float, float]]], precision: float = 0.5) -> tuple[float, float]:
    """Çokgenin en iç noktası (Mapbox polylabel): ince ve kıvrık illerde ağırlık
    merkezi sınır dışına düşebilir, bu nokta düşmez."""
    xs = [p[0] for p in rings[0]]
    ys = [p[1] for p in rings[0]]
    minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)
    size = min(maxx - minx, maxy - miny)
    if size == 0:
        return minx, miny
    h = size / 2
    heap: list[tuple[float, float, float, float, float]] = []

    def push(cx: float, cy: float, hh: float) -> None:
        d = _point_to_rings_dist(cx, cy, rings)
        heapq.heappush(heap, (-(d + hh * math.sqrt(2)), cx, cy, hh, d))

    x = minx
    while x < maxx:
        y = miny
        while y < maxy:
            push(x + h, y + h, h)
            y += size
        x += size
    a = ring_area_px(rings[0]) or 1
    cx = sum((x1 + x2) * (x1 * y2 - x2 * y1) for (x1, y1), (x2, y2) in zip(rings[0], rings[0][1:] + rings[0][:1])) / (6 * a)
    cy = sum((y1 + y2) * (x1 * y2 - x2 * y1) for (x1, y1), (x2, y2) in zip(rings[0], rings[0][1:] + rings[0][:1])) / (6 * a)
    best = (abs(cx), abs(cy), _point_to_rings_dist(abs(cx), abs(cy), rings))
    if best[2] < 0:
        best = ((minx + maxx) / 2, (miny + maxy) / 2, _point_to_rings_dist((minx + maxx) / 2, (miny + maxy) / 2, rings))
    while heap:
        _, x, y, hh, d = heapq.heappop(heap)
        if d > best[2]:
            best = (x, y, d)
        if d + hh * math.sqrt(2) - best[2] <= precision:
            continue
        hh /= 2
        for ox in (-hh, hh):
            for oy in (-hh, hh):
                push(x + ox, y + oy, hh)
    return best[0], best[1]


# ------------------------------------------------------------- Komşu ülkeler
def topo_polygons(topo: dict, obj: str = "countries"):
    """TopoJSON (quantized) -> [(ad, [[halka(boylam, enlem)]])]."""
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(idx: list[int]) -> list[tuple[float, float]]:
        out: list[tuple[float, float]] = []
        for i in idx:
            pts = arcs[i] if i >= 0 else arcs[~i][::-1]
            out.extend(pts[1:] if out else pts)
        return out

    for g in topo["objects"][obj]["geometries"]:
        name = (g.get("properties") or {}).get("name", "")
        if g["type"] == "Polygon":
            polys = [g["arcs"]]
        elif g["type"] == "MultiPolygon":
            polys = g["arcs"]
        else:
            continue
        yield name, [[ring(r) for r in poly] for poly in polys]


def clip_ring(pts: list[tuple[float, float]], box: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    """Sutherland-Hodgman: halkayı dikdörtgene kırp."""
    x0, y0, x1, y1 = box
    edges = [
        (lambda p: p[0] >= x0, lambda a, b: (x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0]))),
        (lambda p: p[0] <= x1, lambda a, b: (x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0]))),
        (lambda p: p[1] >= y0, lambda a, b: (a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0)),
        (lambda p: p[1] <= y1, lambda a, b: (a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1)),
    ]
    for inside, cross in edges:
        if not pts:
            break
        out = []
        prev = pts[-1]
        for cur in pts:
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
            prev = cur
        pts = out
    return pts


def main(src: Path, world: Path | None = None) -> None:
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

    vb = (0.0, 0.0, WIDTH, height)
    if world:
        (vx0, vy0), (vx1, vy1) = project(VIEW_LON[0], VIEW_LAT[1]), project(VIEW_LON[1], VIEW_LAT[0])
        vb = (round(vx0), round(vy0), round(vx1 - vx0), round(vy1 - vy0))

    paths, geo = [], {}
    for f in sorted(feats, key=lambda f: int(f["properties"]["number"])):
        plate = f"TR-{int(f['properties']['number']):02d}"
        d_parts, area, best_area, centroid, label_rings = [], 0.0, -1.0, (0.0, 0.0), []
        for poly in polygons(f["geometry"]):
            outer = poly[0]
            a = ring_area_km2(outer) - sum(ring_area_km2(h) for h in poly[1:])
            area += a
            for ring in poly:
                pts = rdp([project(lon, lat) for lon, lat in ring], EPSILON)
                if len(pts) < 3:
                    continue
                d_parts.append(pts)
            if a > best_area:
                best_area = a
                xs = [project(*c) for c in outer]
                centroid = (sum(p[0] for p in xs) / len(xs), sum(p[1] for p in xs) / len(xs))
                label_rings = [[project(*c) for c in r] for r in poly]
        lx, ly = polylabel(label_rings)
        geo[plate] = {
            "area_km2": round(area),
            "cx": round(centroid[0], 1),
            "cy": round(centroid[1], 1),
            "lx": round(lx, 1),
            "ly": round(ly, 1),
        }
        # data-lx/ly: etiket noktası, data-a: ekran alanı (etiket önceliği için)
        paths.append(
            f'<path id="{plate}" class="province" data-plate="{plate}" '
            f'data-lx="{lx:.1f}" data-ly="{ly:.1f}" data-a="{round(ring_area_px(label_rings[0]))}" '
            f'd="{path_d(d_parts)}"/>'
        )

    neighbor_svg, anchors = "", []
    if world:
        topo = json.loads(world.read_text(encoding="utf-8"))
        m = 260  # kırpma kutusu görünen alandan geniş: geniş ekranda kırpma kenarı görünmesin
        box = (vb[0] - m, vb[1] - m, vb[0] + vb[2] + m, vb[1] + vb[3] + m)
        lands = []
        for name, polys in topo_polygons(topo):
            if name == "Turkey":
                continue
            rings = []
            for poly in polys:
                for ring in poly:
                    pts = clip_ring([project(lon, lat) for lon, lat in ring], box)
                    pts = rdp(pts, NEIGHBOR_EPSILON)
                    if len(pts) >= 3 and ring_area_px(pts) > 0.6:
                        rings.append(pts)
            if not rings:
                continue
            tr_name = NEIGHBORS.get(name, (None,))[0]
            attr = f' data-name="{tr_name}"' if tr_name else ""
            lands.append(f'<path class="land"{attr} d="{path_d(rings)}"/>')
            if tr_name:
                x, y = project(NEIGHBORS[name][1], NEIGHBORS[name][2])
                anchors.append(("country", tr_name, x, y))
        for kind, label, lon, lat in EXTRA_LABELS:
            anchors.append((kind, label, *project(lon, lat)))
        for label, lon, lat in SEAS:
            anchors.append(("sea", label, *project(lon, lat)))
        neighbor_svg = '<g id="neighbors" aria-hidden="true">\n' + "\n".join(lands) + "\n</g>\n"

    anchor_svg = ""
    if anchors:
        anchor_svg = '<g id="anchors" aria-hidden="true">' + "".join(
            f'<circle class="anchor" data-kind="{k}" data-label="{lab}" cx="{x:.1f}" cy="{y:.1f}" r="0"/>'
            for k, lab, x, y in anchors
        ) + "</g>\n"

    svg = (
        f'<svg id="turkey-map" class="map-svg" viewBox="{vb[0]:g} {vb[1]:g} {vb[2]:g} {vb[3]:g}" '
        f'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Türkiye il haritası" '
        f'preserveAspectRatio="xMidYMid meet">\n'
        f'<g id="map-viewport">\n{neighbor_svg}<g id="provinces">\n' + "\n".join(paths) + "\n</g>\n"
        f"{anchor_svg}</g>\n</svg>\n"
    )
    SVG_OUT.parent.mkdir(parents=True, exist_ok=True)
    GEO_OUT.parent.mkdir(parents=True, exist_ok=True)
    SVG_OUT.write_text(svg, encoding="utf-8")
    GEO_OUT.write_text(json.dumps(geo, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(paths)} il yazıldı -> {SVG_OUT} ({SVG_OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) == 3 else None)
