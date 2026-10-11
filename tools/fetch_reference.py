"""Resmi yüzölçümü ve son ADNKS nüfusunu Vikipedi "Türkiye'nin illeri" tablosundan çeker.

Tablodaki yüzölçümleri HGM, nüfuslar TÜİK ADNKS kaynaklıdır (sayfadaki dipnotlar).
Çıktı: data/official_reference.json  ->  {"TR-01": {"area_km2": 13844, "population": ..., "year": 2025}}

Kullanım:
    uv run python tools/fetch_reference.py
"""

from __future__ import annotations

import json
import re
import ssl
import sys
from datetime import date
from pathlib import Path

import httpx
import truststore
from selectolax.lexbor import LexborHTMLParser

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "official_reference.json"
API = "https://tr.wikipedia.org/w/api.php"
PARAMS = {"action": "parse", "page": "Türkiye'nin illeri", "prop": "text", "format": "json", "formatversion": "2"}
HEADERS = {"User-Agent": "turkiye-demografi-atlasi/1.0 (yerel arastirma araci)"}


def number(text: str) -> float | None:
    text = re.sub(r"\[.*?\]", "", text).replace("\xa0", "").replace(" ", "")
    if not text:
        return None
    # Türkçe biçim: 13.844 / 1.234,5
    text = text.replace(".", "").replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return None


def main() -> None:
    ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)  # işletim sistemi sertifika deposu
    r = httpx.get(API, params=PARAMS, headers=HEADERS, timeout=30, verify=ctx)
    r.raise_for_status()
    tree = LexborHTMLParser(r.json()["parse"]["text"])

    table = None
    for t in tree.css("table.wikitable"):
        heads = [h.text(strip=True) for h in t.css("th")]
        if any("Yüzölçümü" in h for h in heads) and any("Plaka" in h for h in heads):
            table = t
            break
    if table is None:
        sys.exit("İl tablosu bulunamadı (sayfa yapısı değişmiş olabilir)")

    heads = [h.text(strip=True) for h in table.css("tr")[0].css("th")]
    col = {
        "area": next(i for i, h in enumerate(heads) if "Yüzölçümü" in h),
        "pop": next(i for i, h in enumerate(heads) if h.startswith("Nüfus")),
        "plate": next(i for i, h in enumerate(heads) if "Plaka" in h),
    }
    year = int(re.search(r"\((\d{4})\)", heads[col["pop"]]).group(1))

    out: dict[str, dict] = {}
    for tr in table.css("tr")[1:]:
        cells = [c.text(strip=True) for c in tr.css("th,td")]
        if len(cells) <= max(col.values()):
            continue
        plate = number(cells[col["plate"]])
        area = number(cells[col["area"]])
        pop = number(cells[col["pop"]])
        if plate and area and pop and 1 <= plate <= 81:
            out[f"TR-{int(plate):02d}"] = {"area_km2": round(area), "population": int(pop), "year": year}

    if len(out) != 81:
        sys.exit(f"81 il beklenirken {len(out)} il ayrıştırıldı")
    payload = {
        "source": "tr.wikipedia.org/wiki/Türkiye'nin_illeri (yüzölçümü: HGM, nüfus: TÜİK ADNKS)",
        "fetched": date.today().isoformat(),
        "population_year": year,
        "provinces": dict(sorted(out.items())),
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    total_area = sum(p["area_km2"] for p in out.values())
    total_pop = sum(p["population"] for p in out.values())
    print(f"{len(out)} il -> {OUT.name}: alan {total_area:,} km², nüfus {total_pop:,} ({year})")


if __name__ == "__main__":
    main()
