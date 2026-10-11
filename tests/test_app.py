import re

import pytest
from fastapi.testclient import TestClient

import app as app_module


@pytest.fixture(scope="module")
def client():
    with TestClient(app_module.app) as c:
        yield c


def test_read_only_backend_on_vercel_like_env(client):
    assert client.get("/healthz").json() == {"ok": True, "backend": "json"}


def test_provinces_sorted_with_history(client):
    r = client.get("/api/v1/provinces?sort_by=population&order=desc&limit=3")
    assert r.status_code == 200
    data = r.json()
    names = [p["province_name"] for p in data["data"]]
    assert names == ["İstanbul", "Ankara", "İzmir"]
    ist = data["data"][0]
    assert ist["slug"] == "istanbul"
    assert len(ist["history"]["population"]) >= 2
    assert "population_density" in ist["history"]  # nüfus geçmişinden türetilir
    assert set(data["meta"]["metrics"]) >= {"population", "birth_rate", "median_age"}


def test_history_can_be_omitted(client):
    p = client.get("/api/v1/provinces?limit=1&history=false").json()["data"][0]
    assert "history" not in p


def test_etag_304(client):
    etag = client.get("/api/v1/provinces").headers["etag"]
    assert client.get("/api/v1/provinces", headers={"If-None-Match": etag}).status_code == 304


def test_filters_and_validation(client):
    assert client.get("/api/v1/provinces?region=ege").json()["count"] == 8
    q = [p["province_name"] for p in client.get("/api/v1/provinces?q=kara").json()["data"]]
    assert "Ankara" in q and "Karabük" in q
    assert client.get("/api/v1/provinces?sort_by=bogus").status_code == 422
    assert client.get("/api/v1/provinces/99").status_code == 404


def test_single_province_by_plate_or_slug(client):
    a = client.get("/api/v1/provinces/63").json()
    b = client.get("/api/v1/provinces/sanliurfa").json()
    assert a["data"]["province_name"] == b["data"]["province_name"] == "Şanlıurfa"
    assert a["region_ranks"]["population"] >= 1


def test_province_page_server_rendered(client):
    html = client.get("/il/sinop").text
    assert re.search(r"<title>Sinop nüfusu \d{4}: [\d.]+ kişi", html)
    assert "Sinop&#39;ta" in html  # Türkçe bulunma eki (Jinja kesme işaretini kaçırır)
    assert '<link rel="canonical" href="http://testserver/il/sinop">' in html
    assert 'data-province="TR-57"' in html
    assert html.count('href="/il/') >= 81  # tablo görünümündeki iç bağlantılar
    assert 'id="initial-data"' in html


@pytest.mark.parametrize("path,target", [("/il/34", "/il/istanbul"), ("/il/Şanlıurfa", "/il/sanliurfa")])
def test_province_redirects(client, path, target):
    r = client.get(path, follow_redirects=False)
    assert r.status_code == 301 and r.headers["location"] == target


def test_unknown_province_404_html(client):
    r = client.get("/il/atlantis")
    assert r.status_code == 404 and "Haritaya dön" in r.text


def test_seo_and_pwa_files(client):
    sm = client.get("/sitemap.xml").text
    assert sm.count("<loc>") == 82
    assert "Sitemap:" in client.get("/robots.txt").text
    mf = client.get("/manifest.webmanifest").json()
    assert {i["sizes"] for i in mf["icons"]} == {"192x192", "512x512"}
    sw = client.get("/sw.js")
    assert "__VERSION__" not in sw.text and sw.headers["service-worker-allowed"] == "/"


def test_static_assets_cached_immutably(client):
    r = client.get("/static/fonts/fonts.css")
    assert r.status_code == 200 and "immutable" in r.headers["cache-control"]


def test_province_profiles_complete():
    """İl profilleri tek dosyada: 81 il, geçerli renk, simge, 973 ilçe; boş alan null/boş liste."""
    import json
    from pathlib import Path

    doc = json.loads((Path(app_module.ROOT) / "data" / "province_profiles.json").read_text(encoding="utf-8"))
    prov = doc["provinces"]
    assert sorted(prov) == [f"TR-{i:02d}" for i in range(1, 82)]
    assert sum(p["district_count"] for p in prov.values()) == 973
    for code, p in prov.items():
        assert re.fullmatch(r"#[0-9A-Fa-f]{6}", p["color"]), code
        assert p.get("emoji") or p.get("icon"), code
        assert p["color_reason"] and p["symbol_label"], code
        assert p["elevation_m"] is None or 0 < p["elevation_m"] < 2500, code
        assert all(isinstance(p[k], list) for k in ("foods", "products", "festivals", "sights")), code


def test_page_embeds_profiles_and_icons(client):
    html = client.get("/").text
    m = re.search(r'<script type="application/json" id="profiles-data">(.*?)</script>', html, re.S)
    assert m and '"TR-81"' in m.group(1)
    # emojisi olmayan illerin SVG simgeleri sayfada tanımlı
    import json
    from pathlib import Path

    prov = json.loads((Path(app_module.ROOT) / "data" / "province_profiles.json").read_text(encoding="utf-8"))["provinces"]
    for p in prov.values():
        if p.get("icon"):
            assert f'id="ico-{p["icon"]}"' in html
    # komşu ülkeler ve deniz adları haritada
    assert 'data-name="Yunanistan"' in html and 'data-label="Karadeniz"' in html
