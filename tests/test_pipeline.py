"""Veri hattı: ayrıştırıcılar, kaynak birleştirme ve SQLite <-> JSON gidiş-dönüşü (ağ yok)."""

import io
import json

import httpx
import pandas as pd
import pytest

import storage as st
import turkstat_pipeline as tp

FB = st.load_fallback()
NAMES = {code: p["province_name"] for code, p in FB["provinces"].items()}
INDEX = {st.normalize_name(n): code for code, n in NAMES.items()}


@pytest.mark.parametrize("raw,expected", [
    ("İSTANBUL", "istanbul"), ("Istanbul", "istanbul"), ("Şanlıurfa", "sanliurfa"),
    ("Afyon", "afyonkarahisar"), ("K.Maraş", "kahramanmaras"), ("İçel", "mersin"), ("Iğdır", "igdir"),
])
def test_normalize_name(raw, expected):
    assert st.normalize_name(raw) == expected


@pytest.mark.parametrize("raw,expected", [("1.234.567", 1234567.0), ("10,5", 10.5), ("-4,6", -4.6), ("..", None), (7, 7.0)])
def test_turkish_numbers(raw, expected):
    assert tp._to_number(raw) == expected


def test_html_table_turkish_format():
    html = "<table><tr><th>İl</th><th>2023</th><th>2024</th></tr>" + "".join(
        f"<tr><td>TR{i:03d}-{n.upper()}</td><td>1.000.000</td><td>{1_000_000 + i:,}</td></tr>".replace(",", ".")
        for i, n in enumerate(NAMES.values())
    ) + "</table>"
    resp = httpx.Response(200, text=html, headers={"content-type": "text/html"}, request=httpx.Request("GET", "http://x/t"))
    header, rows = tp.rows_from_response(tp.Source(metric="population", url="http://x/t"), resp)
    vals = tp.extract_metric(tp.Source(metric="population", url="x"), header, rows, INDEX)
    assert len(vals) == 81 and vals["TR-01"] == 1_000_000  # son sütun (en güncel yıl)


def test_xlsx_with_title_rows_and_total():
    rows = [["Tablo başlığı", None], ["İl", 2024]] + [[n, 12.5] for n in NAMES.values()] + [["Türkiye", 11.0]]
    buf = io.BytesIO()
    pd.DataFrame(rows).to_excel(buf, header=False, index=False)
    resp = httpx.Response(200, content=buf.getvalue(), request=httpx.Request("GET", "http://x/t.xlsx"))
    src = tp.Source(metric="birth_rate", url="http://x/t.xlsx")
    header, rows = tp.rows_from_response(src, resp)
    vals = tp.extract_metric(src, header, rows, INDEX)
    assert len(vals) == 81 and set(vals.values()) == {12.5}


def _jsonstat(values_by_year: dict[str, dict[str, float]], labels: dict[str, str]) -> dict:
    """geo x time JSON-stat 2.0 (Eurostat biçimi)."""
    geos, times = list(labels), sorted(values_by_year)
    value = {}
    for gi, g in enumerate(geos):
        for ti, t in enumerate(times):
            v = values_by_year[t].get(g)
            if v is not None:
                value[str(gi * len(times) + ti)] = v
    return {
        "id": ["freq", "geo", "time"], "size": [1, len(geos), len(times)], "value": value,
        "dimension": {
            "freq": {"category": {"index": {"A": 0}}},
            "geo": {"category": {"index": {g: i for i, g in enumerate(geos)}, "label": labels}},
            "time": {"category": {"index": {t: i for i, t in enumerate(times)}}},
        },
    }


def test_jsonstat_latest_full_year_and_offset():
    labels = {f"TR{i:03d}": n for i, n in enumerate(NAMES.values())} | {"DE111": "Stuttgart"}
    full = {g: 10.0 + i * 0.1 for i, g in enumerate(labels)}
    data = _jsonstat({"2023": full, "2024": full, "2025": {"TR000": 9.9}}, labels)  # 2025 eksik -> 2024 seçilir
    res = tp.extract_jsonstat(tp.Source(metric="birth_rate", url="x"), data, INDEX)
    assert res.year == 2024 and len(res.values) == 81
    assert all(set(s) == {2023, 2024} for s in res.series.values())
    shifted = tp.extract_jsonstat(tp.Source(metric="birth_rate", url="x", year_offset=-1), data, INDEX)
    assert shifted.year == 2023


def test_jsonstat_rejects_ambiguous_dimension():
    data = _jsonstat({"2024": {}}, {"TR100": "İstanbul"})
    data["id"].insert(0, "unit")
    data["size"].insert(0, 2)
    data["dimension"]["unit"] = {"category": {"index": {"YR": 0, "PC": 1}}}
    with pytest.raises(ValueError, match="unit"):
        tp.extract_jsonstat(tp.Source(metric="median_age", url="x"), data, INDEX)


def test_merge_prefers_newest_year_and_derives_growth():
    src = lambda m, name: tp.Source(metric=m, url="x", source_name=name)  # noqa: E731
    old = tp.Fetched({"TR-01": 100.0}, 2024, {"TR-01": {2023: 90.0, 2024: 100.0}})
    new = tp.Fetched({"TR-01": 110.0}, 2025, {"TR-01": {2025: 110.0}})
    b = tp.Fetched({"TR-01": 12.0}, 2024, {"TR-01": {2023: 13.0, 2024: 12.0}})
    d = tp.Fetched({"TR-01": 5.0}, 2024, {"TR-01": {2023: 5.5, 2024: 5.0}})
    out = tp.merge([(src("population", "A"), old), (src("population", "B"), new),
                    (src("birth_rate", "E"), b), (src("death_rate", "E"), d)])
    assert out["population"].values == {"TR-01": 110.0} and out["population"].year == 2025
    assert out["population"].series["TR-01"] == {2023: 90.0, 2024: 100.0, 2025: 110.0}
    assert out["natural_growth_rate"].series["TR-01"] == {2023: 7.5, 2024: 7.0}


def test_seed_freeze_roundtrip(tmp_path):
    db, out = tmp_path / "t.db", tmp_path / "fb.json"
    st.init_db(db)
    ds = st.load_dataset(db)
    assert len(ds["provinces"]) == 81 and ds["metrics"]
    st.freeze_fallback(db, out)
    frozen = json.loads(out.read_text(encoding="utf-8"))
    assert frozen["provinces"]["TR-34"]["population"] == FB["provinces"]["TR-34"]["population"]
    assert frozen["provinces"]["TR-34"]["history"] == FB["provinces"]["TR-34"]["history"]


def test_mode_windows():
    assert st.mode_for(None) == "fallback"
    from datetime import datetime, timedelta
    assert st.mode_for(datetime.now(st.TZ).isoformat()) == "live"
    assert st.mode_for((datetime.now(st.TZ) - timedelta(days=400)).isoformat()) == "cached"
