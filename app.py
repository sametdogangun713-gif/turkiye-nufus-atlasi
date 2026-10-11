"""Türkiye Nüfus Atlası — FastAPI uygulaması.

Yerel:   uv run uvicorn app:app --reload
Vercel:  app.py otomatik algılanır; dosya sistemi salt okunur olduğundan veri
         data/fallback_turkey_data.json'dan (son --freeze) okunur.

Ortam değişkenleri:
    SITE_URL           -> kanonik adres (örn. https://nufus-atlasi.vercel.app). Yoksa istekten türetilir.
    DATA_READONLY=1    -> SQLite yerine yalnızca JSON (Vercel'de VERCEL=1 iken otomatik)
    LIVE_WINDOW_DAYS   -> son eşitleme bu kadar günden yeniyse durum "live" (varsayılan 40)
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from statistics import mean
from typing import Any
from xml.sax.saxutils import escape

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

import storage as st

log = logging.getLogger("app")
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
READ_ONLY = bool(os.getenv("VERCEL") or os.getenv("DATA_READONLY"))


class SortField(str, Enum):
    plate_code = "plate_code"
    province_name = "province_name"
    region = "region"
    population = "population"
    population_density = "population_density"
    birth_rate = "birth_rate"
    death_rate = "death_rate"
    natural_growth_rate = "natural_growth_rate"
    net_migration_rate = "net_migration_rate"
    median_age = "median_age"


class Order(str, Enum):
    asc = "asc"
    desc = "desc"


# ---------------------------------------------------------------------------
# Biçimlendirme (sunucu tarafı metinler için Türkçe sayı biçimi)
# ---------------------------------------------------------------------------

def tr_int(v: float) -> str:
    return f"{round(v):,}".replace(",", ".")


def tr_dec(v: float, d: int = 1) -> str:
    return f"{v:.{d}f}".replace(".", ",")


def tr_people(v: float) -> str:
    if v >= 1e6:
        return f"{tr_dec(v / 1e6)} milyon"
    if v >= 1e4:
        return f"{tr_int(v / 1e3)} bin"
    return tr_int(v)


def tr_locative(word: str) -> str:
    """Bulunma eki: Sinop'ta, Hakkari'de, Şanlıurfa'da."""
    vowels = [c for c in word.lower() if c in "aeıioöuü"] or ["a"]
    back = vowels[-1] in "aıou"
    hard = word[-1].lower() in "çfhkpsşt"
    return f"{word}'{'t' if hard else 'd'}{'a' if back else 'e'}"


# ---------------------------------------------------------------------------
# Veri anlık görüntüsü
# ---------------------------------------------------------------------------

@dataclass
class Snapshot:
    provinces: list[dict[str, Any]]
    by_code: dict[str, dict[str, Any]]
    by_slug: dict[str, dict[str, Any]]
    meta: dict[str, Any]
    etag: str
    payload_json: str  # sayfaya gömülen ilk veri (API yanıtıyla aynı biçim)


def _weighted_avgs(rows: list[dict[str, Any]]) -> dict[str, float]:
    """Oranlar nüfus ağırlıklı; nüfus ve alan toplam."""
    pop = sum(p["population"] for p in rows) or 1
    area = sum(p["area_km2"] or 0 for p in rows) or 1
    out: dict[str, float] = {"population": pop, "area_km2": area, "population_density": round(pop / area, 1)}
    for f in ("birth_rate", "death_rate", "natural_growth_rate", "net_migration_rate", "median_age"):
        vals = [(p[f], p["population"]) for p in rows if p[f] is not None]
        out[f] = round(sum(v * w for v, w in vals) / (sum(w for _, w in vals) or 1), 2)
    out["avg_province_population"] = round(mean(p["population"] for p in rows))
    return out


class DataStore:
    """DB (ya da JSON) değişince yeniden yüklenir; CLI --sync sonrası yeniden başlatma gerekmez."""

    def __init__(self) -> None:
        self.read_only = READ_ONLY
        self._sig: tuple | None = None
        self._snap: Snapshot | None = None
        self._loaded_at = 0.0

    def _signature(self) -> tuple:
        files = [st.FALLBACK_JSON] if self.read_only else [st.DB_PATH, st.DB_PATH.with_name(st.DB_PATH.name + "-wal")]
        sig = []
        for p in files:
            with suppress(FileNotFoundError):
                s = p.stat()
                sig += [s.st_mtime_ns, s.st_size]
        return tuple(sig)

    def get(self) -> Snapshot:
        sig = self._signature()
        # live -> cached geçişi zamana bağlı; dosya değişmese de periyodik yenile
        if self._snap is None or sig != self._sig or time.monotonic() - self._loaded_at > 300:
            self._snap = self._load()
            self._sig, self._loaded_at = sig, time.monotonic()
        return self._snap

    def _load(self) -> Snapshot:
        ds = None
        if not self.read_only:
            try:
                ds = st.load_dataset(st.DB_PATH)
            except Exception:
                log.exception("SQLite okunamadı, JSON yedek veriye geçiliyor")
                self.read_only = True
        if ds is None:
            ds = st.load_dataset(None)

        provinces = ds["provinces"]
        for p in provinces:
            p["slug"] = st.slugify(p["province_name"])
        national = _weighted_avgs(provinces)
        regions = {}
        for region in sorted({p["region"] for p in provinces}):
            members = [p for p in provinces if p["region"] == region]
            regions[region] = {**_weighted_avgs(members), "province_count": len(members)}
        for f in st.NUMERIC_FIELDS:  # sıralamalar (1 = en yüksek)
            ranked = sorted(provinces, key=lambda p: p[f] if p[f] is not None else float("-inf"), reverse=True)
            for i, p in enumerate(ranked, 1):
                p.setdefault("ranks", {})[f] = i

        meta = {
            "mode": ds["mode"],
            "synced_at": ds["synced_at"],
            "last_sync": ds["last_sync"],
            "backend": ds["backend"],
            "metrics": ds["metrics"],
            "province_count": len(provinces),
            "last_updated": max((p["last_updated"] or "" for p in provinces), default=None),
            "national": national,
            "regions": regions,
        }
        public = [_public(p) for p in provinces]
        raw = json.dumps([public, {k: v for k, v in meta.items() if k != "last_sync"}], sort_keys=True, default=str)
        etag = hashlib.blake2b(raw.encode(), digest_size=12).hexdigest()
        payload = {"meta": meta, "count": len(public), "data": public}
        return Snapshot(
            provinces, {p["plate_code"]: p for p in provinces}, {p["slug"]: p for p in provinces},
            meta, etag, json.dumps(payload, ensure_ascii=False, default=str).replace("</", "<\\/"),
        )


def _public(p: dict[str, Any]) -> dict[str, Any]:
    return {k: p.get(k) for k in st.FIELDS} | {"slug": p["slug"], "ranks": p.get("ranks", {}),
                                               "history": p.get("history", {})}


store = DataStore()


# ---------------------------------------------------------------------------
# Uygulama
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_: FastAPI):
    if not store.read_only:
        try:
            st.init_db()
            if not st.CACHE_JSON.exists():
                st.export_cache()
        except OSError:
            log.warning("Veri dizini yazılamıyor; salt okunur JSON moduna geçildi")
            store.read_only = True
    yield


app = FastAPI(title="Türkiye Nüfus Atlası", version="1.0.0", lifespan=lifespan,
              docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.mount("/static", StaticFiles(directory=STATIC), name="static")
templates = Jinja2Templates(directory=ROOT / "templates")

_ASSETS = ("css/styles.css", "js/map_app.js", "fonts/fonts.css")
_asset_cache: dict[tuple, str] = {}


def asset_version() -> str:
    """İçerik özetinden önbellek kırıcı. Vercel'de dosya mtime'ları sabit olduğundan içerik kullanılır."""
    key = tuple((STATIC / f).stat().st_mtime_ns for f in _ASSETS)
    if key not in _asset_cache:
        h = hashlib.md5()
        for f in _ASSETS:
            h.update((STATIC / f).read_bytes())
        _asset_cache.clear()
        _asset_cache[key] = h.hexdigest()[:10]
    return _asset_cache[key]


@app.middleware("http")
async def cache_headers(request: Request, call_next):
    """API: ETag + 304. HTML ve API: tarayıcıda kısa, CDN'de uzun önbellek (veri yalnızca dağıtımla değişir)."""
    path = request.url.path
    if path.startswith("/api/v1/"):
        etag = f'W/"{store.get().etag}-{hashlib.md5(str(request.url.query).encode()).hexdigest()[:6]}"'
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag})
        resp = await call_next(request)
        if resp.status_code == 200:
            resp.headers["ETag"] = etag
            resp.headers["Cache-Control"] = "public, max-age=60, s-maxage=3600, stale-while-revalidate=86400"
        return resp
    resp = await call_next(request)
    if path.startswith("/static/"):
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif resp.status_code == 200 and resp.headers.get("content-type", "").startswith(("text/html", "application/xml", "text/plain")):
        resp.headers.setdefault("Cache-Control", "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return resp


PROFILES_JSON = ROOT / "data" / "province_profiles.json"
_profiles_cache: dict[int, str] = {}


def profiles_json() -> str:
    """İl profilleri (simge, kültürel renk, rakım, alan kodu, gezilecek yerler...).
    Tek dosyadan okunur, sayfaya gömülür; dosya değişince yeniden okunur."""
    try:
        key = PROFILES_JSON.stat().st_mtime_ns
    except OSError:
        return "{}"
    if key not in _profiles_cache:
        data = json.loads(PROFILES_JSON.read_text(encoding="utf-8"))
        _profiles_cache.clear()
        _profiles_cache[key] = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return _profiles_cache[key]


def site_url(request: Request) -> str:
    return (os.getenv("SITE_URL") or str(request.base_url)).rstrip("/")


def _year(snap: Snapshot, metric: str) -> str:
    y = (snap.meta["metrics"].get(metric) or {}).get("year")
    return str(y) if y else ""


def _page_context(request: Request, snap: Snapshot, p: dict[str, Any] | None) -> dict[str, Any]:
    base = site_url(request)
    nat = snap.meta["national"]
    pop_year = _year(snap, "population")
    if p is None:
        hi = max(snap.provinces, key=lambda x: x["population"])
        lo = min(snap.provinces, key=lambda x: x["population"])
        title = f"Türkiye Nüfus Atlası: 81 ilin nüfus, doğum, ölüm ve göç haritası ({pop_year})"
        desc = (f"Türkiye'nin {pop_year} nüfusu {tr_people(nat['population'])}. 81 ilde nüfus, yoğunluk, "
                f"doğum ve ölüm hızı, net göç ve ortanca yaş; TÜİK ve Eurostat verisiyle etkileşimli harita.")
        lede_h = f"{hi['province_name']} {tr_people(hi['population'])}, {lo['province_name']} {tr_people(lo['population'])} kişi."
        lede_p = (f"En kalabalık ve en az nüfuslu il. Türkiye'nin toplam nüfusu {tr_people(nat['population'])}; "
                  f"bunun yüzde {tr_dec(hi['population'] / nat['population'] * 100)}'i {tr_locative(hi['province_name'])} yaşıyor.")
        canonical = f"{base}/"
    else:
        name = p["province_name"]
        title = f"{name} nüfusu {pop_year}: {tr_int(p['population'])} kişi | Türkiye Nüfus Atlası"
        desc = (f"{name} ({p['region']} Bölgesi) {pop_year} nüfusu {tr_int(p['population'])}. "
                f"Doğum hızı binde {tr_dec(p['birth_rate'])}, ölüm hızı binde {tr_dec(p['death_rate'])}, "
                f"net göç binde {tr_dec(p['net_migration_rate'])}, ortanca yaş {tr_dec(p['median_age'])}. "
                f"81 il içinde nüfusta {p['ranks']['population']}. sırada.")
        lede_h = f"{tr_locative(name)} {tr_people(p['population'])} kişi yaşıyor."
        age_diff = p["median_age"] - nat["median_age"]
        lede_p = (f"{p['region']} Bölgesi. Nüfusta 81 il içinde {p['ranks']['population']}. sırada; "
                  f"ortanca yaş {tr_dec(p['median_age'])}, Türkiye ortalamasının "
                  f"{tr_dec(abs(age_diff))} yıl {'üstünde' if age_diff > 0 else 'altında'}.")
        canonical = f"{base}/il/{p['slug']}"
    return {
        "v": asset_version(),
        "title": title,
        "description": desc,
        "canonical": canonical,
        "og_image": f"{base}/static/icons/og.png",
        "lede_h": lede_h,
        "lede_p": lede_p,
        "province": p,
        "provinces": snap.provinces,
        "years": {k: _year(snap, k) for k in st.NUMERIC_FIELDS},
        "initial_json": snap.payload_json,
        "profiles_json": profiles_json(),
        "tr_int": tr_int,
        "tr_dec": tr_dec,
        "jsonld": json.dumps(_jsonld(base, snap, p), ensure_ascii=False).replace("</", "<\\/"),
    }


def _jsonld(base: str, snap: Snapshot, p: dict[str, Any] | None) -> dict[str, Any]:
    """Arama motorları için yapılandırılmış veri (schema.org Dataset)."""
    srcs = sorted({m["source"] for m in snap.meta["metrics"].values() if m.get("official")})
    data: dict[str, Any] = {
        "@context": "https://schema.org",
        "@type": "Dataset",
        "name": "Türkiye il bazında demografi göstergeleri",
        "description": "81 il için nüfus, nüfus yoğunluğu, kaba doğum ve ölüm hızı, net göç hızı ve ortanca yaş.",
        "url": f"{base}/",
        "inLanguage": "tr",
        "spatialCoverage": "Türkiye",
        "isBasedOn": srcs,
        "distribution": [{"@type": "DataDownload", "encodingFormat": "application/json",
                          "contentUrl": f"{base}/api/v1/provinces"}],
    }
    if p:
        data["name"] = f"{p['province_name']} demografi göstergeleri"
        data["url"] = f"{base}/il/{p['slug']}"
        data["spatialCoverage"] = f"{p['province_name']}, Türkiye"
    return data


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    snap = store.get()
    return templates.TemplateResponse(request, "index.html", _page_context(request, snap, None))


@app.get("/il/{slug}", response_class=HTMLResponse)
async def province_page(request: Request, slug: str):
    snap = store.get()
    key = slug.lower()
    if key.isdigit():  # /il/34 -> /il/istanbul
        p = snap.by_code.get(f"TR-{int(key):02d}")
        if p:
            return RedirectResponse(f"/il/{p['slug']}", status_code=301)
    p = snap.by_slug.get(st.slugify(key))
    if not p:
        raise HTTPException(404, "İl bulunamadı")
    if p["slug"] != slug:  # büyük harf / Türkçe karakterli adres -> kanonik
        return RedirectResponse(f"/il/{p['slug']}", status_code=301)
    return templates.TemplateResponse(request, "index.html", _page_context(request, snap, p))


@app.get("/api/v1/provinces")
async def list_provinces(
    sort_by: SortField = SortField.plate_code,
    order: Order = Order.asc,
    region: str | None = Query(None, description="Bölge adı (örn. Ege)"),
    q: str | None = Query(None, max_length=40, description="İl adı araması"),
    limit: int = Query(81, ge=1, le=81),
    history: bool = Query(True, description="Yıllık seriler dahil edilsin mi"),
):
    snap = store.get()
    rows = snap.provinces
    if region:
        rows = [p for p in rows if st.normalize_name(p["region"]) == st.normalize_name(region)]
    if q:
        needle = st.normalize_name(q)
        rows = [p for p in rows if needle in st.normalize_name(p["province_name"])]
    key = sort_by.value
    rows = sorted(
        rows,
        key=lambda p: (p[key] is None, p[key] if isinstance(p[key], (int, float)) else st.normalize_name(str(p[key]))),
        reverse=order is Order.desc,
    )[:limit]
    data = [_public(p) for p in rows]
    if not history:
        for d in data:
            d.pop("history")
    return {"meta": snap.meta, "count": len(data), "data": data}


@app.get("/api/v1/provinces/{plate_code}")
async def get_province(plate_code: str):
    snap = store.get()
    code = plate_code.upper()
    if code.isdigit():
        code = f"TR-{int(code):02d}"
    p = snap.by_code.get(code) or snap.by_slug.get(st.slugify(plate_code))
    if not p:
        raise HTTPException(404, f"İl bulunamadı: {plate_code}")
    peers = [x for x in snap.provinces if x["region"] == p["region"]]
    region_ranks = {f: 1 + sum(1 for x in peers if (x[f] or 0) > (p[f] or 0)) for f in st.NUMERIC_FIELDS}
    return {
        "data": _public(p),
        "region_ranks": region_ranks,
        "region_avg": snap.meta["regions"][p["region"]],
        "national_avg": snap.meta["national"],
        "meta": {k: snap.meta[k] for k in ("mode", "synced_at", "metrics")},
    }


@app.get("/api/v1/status")
async def status():
    snap = store.get()
    return {
        "mode": snap.meta["mode"],
        "synced_at": snap.meta["synced_at"],
        "last_sync": snap.meta["last_sync"],
        "last_updated": snap.meta["last_updated"],
        "backend": snap.meta["backend"],
        "etag": snap.etag,
    }


# ---------------------------------------------------------------------------
# Arama motoru, PWA ve kök dosyaları
# ---------------------------------------------------------------------------

@app.get("/sitemap.xml")
async def sitemap(request: Request):
    snap = store.get()
    base = site_url(request)
    lastmod = (snap.meta["synced_at"] or snap.meta["last_updated"] or "")[:10]
    urls = [f"{base}/"] + [f"{base}/il/{p['slug']}" for p in snap.provinces]
    body = "".join(
        f"<url><loc>{escape(u)}</loc>{f'<lastmod>{lastmod}</lastmod>' if lastmod else ''}</url>" for u in urls
    )
    xml = f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{body}</urlset>'
    return Response(xml, media_type="application/xml")


@app.get("/robots.txt", response_class=PlainTextResponse)
async def robots(request: Request):
    return f"User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: {site_url(request)}/sitemap.xml\n"


@app.get("/manifest.webmanifest")
async def manifest():
    data = {
        "name": "Türkiye Nüfus Atlası",
        "short_name": "Nüfus Atlası",
        "description": "81 ilin nüfus, doğum, ölüm, göç ve yaş haritası",
        "lang": "tr",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": "#F3F5F4",
        "theme_color": "#F3F5F4",
        "icons": [
            {"src": "/static/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/static/icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/static/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    return Response(json.dumps(data, ensure_ascii=False), media_type="application/manifest+json",
                    headers={"Cache-Control": "public, max-age=86400"})


@app.get("/sw.js")
async def service_worker():
    """Kapsamı "/" olsun diye kökten sunulur; sürüm, varlık özetinden gelir."""
    js = (STATIC / "js" / "sw.js").read_text(encoding="utf-8").replace("__VERSION__", asset_version())
    return Response(js, media_type="application/javascript",
                    headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return RedirectResponse("/static/icons/icon-192.png", status_code=308)


@app.get("/healthz", include_in_schema=False)
async def healthz():
    return {"ok": True, "backend": store.get().meta["backend"]}


@app.exception_handler(404)
async def not_found(request: Request, exc: HTTPException):
    if request.url.path.startswith("/api/"):
        return Response(json.dumps({"detail": exc.detail}, ensure_ascii=False), status_code=404,
                        media_type="application/json")
    return HTMLResponse(
        "<!doctype html><meta charset=utf-8><title>Sayfa bulunamadı</title>"
        "<p style='font-family:system-ui;padding:40px'>Bu adreste bir sayfa yok. "
        "<a href='/'>Haritaya dön</a></p>",
        status_code=404,
    )
