"""Demografi veri hattı: resmi kaynakları çeker, SQLite'a yazar, yedek veriyi üretir.

Katmanlar:
  1. Asenkron çekici  -> data/sources.json içindeki kaynaklar (Eurostat JSON-stat,
                         TÜİK xls/xlsx/csv/html tabloları, yerel referans dosyası)
  2. Yerel depo       -> data/demographics.db (SQLite) + data/cache_turkey_demographics.json
  3. Yedek veri       -> data/fallback_turkey_data.json (81 il; Vercel bu dosyadan çalışır)

CLI:
  uv run python turkstat_pipeline.py --sync      # kaynakları çek, DB'yi güncelle (sunucu yeniden başlatılmaz)
  uv run python turkstat_pipeline.py --status    # son eşitleme durumu ve metrik kaynakları
  uv run python turkstat_pipeline.py --reset     # DB'yi yedek veriden yeniden kur
  uv run python turkstat_pipeline.py --freeze    # güncel DB'yi yedek veri dosyasına yaz
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import logging
import random
import re
import ssl
import time
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

import httpx
import pandas as pd
import truststore
from selectolax.lexbor import LexborHTMLParser
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

from storage import (  # noqa: F401  (CLI ve testler için yeniden dışa aktarım)
    CACHE_JSON, DB_PATH, FALLBACK_JSON, FIELDS, ROOT, SOURCES_JSON, TZ,
    connect, data_mode, export_cache, freeze_fallback, init_db, last_sync,
    load_fallback, normalize_name, read_history, read_metric_meta, read_provinces,
    reset_db, synced_at,
)

log = logging.getLogger("turkstat")

# Kaynaklardan çekilebilen metrikler ve makul değer aralıkları (doğrulama için)
METRIC_RANGES: dict[str, tuple[float, float]] = {
    "population": (50_000, 30_000_000),
    "birth_rate": (2, 60),
    "death_rate": (1, 30),
    "net_migration_rate": (-150, 150),
    "median_age": (12, 60),
}
MIN_PROVINCE_MATCHES = 70  # bir kaynağın kabul edilmesi için eşleşmesi gereken il sayısı

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
]


# ---------------------------------------------------------------------------
# Kibar HTTP istemcisi: UA rotasyonu, robots.txt, hız sınırı, üstel geri çekilme
# ---------------------------------------------------------------------------

def tls_context() -> ssl.SSLContext:
    """İşletim sisteminin sertifika deposu (truststore). Kurumsal ağ/antivirüs kök
    sertifikaları certifi listesinde olmadığında doğrulama böylece yine yapılır."""
    return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)


class RetryableStatus(Exception):
    def __init__(self, status: int, url: str):
        super().__init__(f"HTTP {status} {url}")
        self.status = status


class PoliteClient:
    def __init__(self, min_interval: float = 2.0, timeout: float = 60.0, attempts: int = 4):
        self.min_interval = min_interval
        self.attempts = attempts
        self._last: dict[str, float] = {}
        self._robots: dict[str, RobotFileParser | None] = {}
        self._lock = asyncio.Lock()
        self._robots_lock = asyncio.Lock()
        self._client = httpx.AsyncClient(
            timeout=timeout, follow_redirects=True, limits=httpx.Limits(max_connections=4),
            verify=tls_context(),
        )

    async def __aenter__(self) -> "PoliteClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        return {
            "User-Agent": random.choice(USER_AGENTS),
            "Accept": "text/html,application/xhtml+xml,application/json,application/vnd.ms-excel,"
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*;q=0.8",
            "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6",
            "Accept-Encoding": "gzip, deflate",
            "Cache-Control": "no-cache",
            "DNT": "1",
        }

    async def _allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        async with self._robots_lock:  # eşzamanlı kaynaklar robots.txt'yi bir kez çeksin
            if origin not in self._robots:
                rp: RobotFileParser | None = RobotFileParser()
                try:
                    r = await self._client.get(origin + "/robots.txt", headers=self._headers())
                    if r.status_code == 200:
                        rp.parse(r.text.splitlines())
                    else:
                        rp = None  # robots.txt yok -> serbest
                except httpx.HTTPError:
                    rp = None
                self._robots[origin] = rp
        rp = self._robots[origin]
        return rp is None or rp.can_fetch("*", url)

    async def _throttle(self, host: str) -> None:
        async with self._lock:
            wait = self._last.get(host, 0) + self.min_interval - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait + random.uniform(0, 0.5))
            self._last[host] = time.monotonic()

    async def get(self, url: str) -> httpx.Response:
        if not await self._allowed(url):
            raise PermissionError(f"robots.txt izin vermiyor: {url}")
        host = urlsplit(url).netloc
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(self.attempts),
            wait=wait_exponential_jitter(initial=1, max=30),
            retry=retry_if_exception_type((httpx.TransportError, RetryableStatus)),
            reraise=True,
        ):
            with attempt:
                await self._throttle(host)
                log.info("GET %s (deneme %d)", url, attempt.retry_state.attempt_number)
                r = await self._client.get(url, headers=self._headers())
                if r.status_code in (429, 500, 502, 503, 504):
                    raise RetryableStatus(r.status_code, url)
                r.raise_for_status()
                return r
        raise AssertionError("unreachable")


# ---------------------------------------------------------------------------
# Kaynak tanımı ve sonuç
# ---------------------------------------------------------------------------

@dataclass
class Source:
    metric: str
    url: str
    format: str = "auto"          # auto | xlsx | xls | csv | html | json | jsonstat | reference
    column: str | int = "last"    # "last" = satırdaki son sayısal hücre, int = sütun indeksi, str = başlık
    scale: float = 1.0            # örn. yüzde -> binde için 10
    description: str = ""
    enabled: bool = True
    json_path: list[str] = field(default_factory=list)  # json için kayıt listesine giden anahtarlar
    name_key: str = "il"
    value_key: str = "deger"
    source_name: str = ""         # arayüzde gösterilen kaynak adı
    official: bool = True         # resmi istatistik mi
    geo_prefix: str = "TR"        # jsonstat: yalnızca bu önekli NUTS-3 kodları
    year_offset: int = 0          # jsonstat: yıl düzeltmesi (1 Ocak Y nüfusu = ADNKS Y-1 yıl sonu -> -1)


@dataclass
class Fetched:
    values: dict[str, float]                                          # plaka -> güncel değer
    year: int | None = None                                           # güncel değerin yılı
    series: dict[str, dict[int, float]] = field(default_factory=dict)  # plaka -> {yıl: değer}


def load_sources(path: Path = SOURCES_JSON) -> list[Source]:
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for s in raw.get("sources", []):
        if not s.get("enabled", True) or not s.get("url"):
            continue
        if s.get("metric") not in METRIC_RANGES:
            log.warning("Bilinmeyen metrik atlandı: %s", s.get("metric"))
            continue
        out.append(Source(**{k: v for k, v in s.items() if k in Source.__dataclass_fields__}))
    return out


# ---------------------------------------------------------------------------
# Ayrıştırıcılar
# ---------------------------------------------------------------------------

def _to_number(v: Any) -> float | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace("\xa0", "").replace(" ", "")
    if not s or s in {"-", "..", "…"}:
        return None
    # Türkçe biçim: 1.234.567,8
    if re.fullmatch(r"-?\d{1,3}(\.\d{3})+(,\d+)?", s):
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"-?\d+,\d+", s):
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _detect_format(src: Source, resp: httpx.Response) -> str:
    if src.format != "auto":
        return src.format
    ctype = resp.headers.get("content-type", "").lower()
    path = urlsplit(str(resp.url)).path.lower()
    head = resp.content[:8]
    if head.startswith(b"PK"):
        return "xlsx"
    if head.startswith(b"\xd0\xcf\x11\xe0"):
        return "xls"
    if "json" in ctype or path.endswith(".json"):
        return "json"
    if "csv" in ctype or path.endswith(".csv"):
        return "csv"
    return "html"


def rows_from_response(src: Source, resp: httpx.Response) -> tuple[list[str], list[list[Any]]]:
    """(başlık, satırlar) döndürür; başlık yoksa boş liste."""
    fmt = _detect_format(src, resp)
    if fmt in ("xlsx", "xls"):
        engine = "openpyxl" if fmt == "xlsx" else "xlrd"
        sheets = pd.read_excel(io.BytesIO(resp.content), sheet_name=None, header=None, engine=engine)
        rows: list[list[Any]] = []
        for df in sheets.values():
            rows.extend(df.where(pd.notna(df), None).values.tolist())
        return [], rows
    if fmt == "csv":
        text = resp.content.decode("utf-8-sig", errors="replace")
        sep = ";" if text.count(";") > text.count(",") else ","
        df = pd.read_csv(io.StringIO(text), sep=sep, header=None, dtype=str)
        return [], df.where(pd.notna(df), None).values.tolist()
    if fmt == "json":
        node: Any = resp.json()
        for key in src.json_path:
            node = node[key]
        return [], [[rec.get(src.name_key), rec.get(src.value_key)] for rec in node]
    tree = LexborHTMLParser(resp.text)
    header: list[str] = []
    rows = []
    for table in tree.css("table"):
        for tr in table.css("tr"):
            cells = [c.text(strip=True) for c in tr.css("th,td")]
            if tr.css_first("th") and not header:
                header = cells
            rows.append(cells)
    return header, rows


def extract_metric(src: Source, header: list[str], rows: list[list[Any]],
                   name_index: dict[str, str]) -> dict[str, float]:
    """Tablo satırlarında il adını bulur ve seçilen sütundaki sayıyı alır."""
    col_idx: int | None = None
    if isinstance(src.column, int):
        col_idx = src.column
    elif src.column != "last" and header:
        wanted = normalize_name(src.column)
        col_idx = next((i for i, h in enumerate(header) if normalize_name(h) == wanted), None)

    lo, hi = METRIC_RANGES[src.metric]
    found: dict[str, float] = {}
    for row in rows:
        plate = None
        name_pos = -1
        for i, cell in enumerate(row):
            if cell is None:
                continue
            # "TR621-Adana", "Adana (01)" gibi biçimleri parçala
            for piece in re.split(r"[-–(/)]", str(cell)):
                key = normalize_name(piece)
                if key in name_index:
                    plate, name_pos = name_index[key], i
                    break
            if plate:
                break
        if not plate or plate in found:
            continue
        if col_idx is not None:
            value = _to_number(row[col_idx]) if col_idx < len(row) else None
        else:
            nums = [n for n in (_to_number(c) for c in row[name_pos + 1:]) if n is not None]
            value = nums[-1] if nums else None
        if value is None:
            continue
        value *= src.scale
        if lo <= value <= hi:
            found[plate] = value
    return found


def extract_jsonstat(src: Source, data: dict[str, Any], name_index: dict[str, str]) -> Fetched:
    """JSON-stat 2.0 (Eurostat API) -> tüm yılların serisi + en güncel dolu yıl.

    URL'deki filtreler geo ve time dışındaki her boyutu tek değere indirmeli
    (örn. indic_de=GBIRTHRT&unit=YR); aksi hâlde hangi serinin alındığı belirsiz olur.
    """
    if "error" in data:
        raise ValueError(f"API hatası: {data['error']}")
    ids, size, values = data["id"], data["size"], data["value"]
    dims = {k: data["dimension"][k]["category"] for k in ids}
    for k, n in zip(ids, size):
        if k not in ("geo", "time") and n != 1:
            raise ValueError(f"'{k}' boyutunda {n} değer var; URL'de tek değere filtreleyin")
    strides = [1] * len(size)
    for i in range(len(size) - 2, -1, -1):
        strides[i] = strides[i + 1] * size[i + 1]
    gi, ti = ids.index("geo"), ids.index("time")
    geo_index, labels = dims["geo"]["index"], dims["geo"].get("label", {})
    time_index = dims["time"]["index"]

    # NUTS-3 kodu -> plaka (etiket üzerinden: "İstanbul", "Afyonkarahisar"...)
    plates = {}
    for code in geo_index:
        if code.startswith(src.geo_prefix) and len(code) == 5:
            plate = name_index.get(normalize_name(labels.get(code, "")))
            if plate:
                plates[code] = plate

    lo, hi = METRIC_RANGES[src.metric]
    series: dict[str, dict[int, float]] = {}
    counts: dict[int, int] = {}
    for t, t_pos in time_index.items():
        year = int(str(t)[:4]) + src.year_offset
        for code, plate in plates.items():
            pos = geo_index[code] * strides[gi] + t_pos * strides[ti]
            v = values.get(str(pos)) if isinstance(values, dict) else values[pos]
            if v is not None and lo <= v * src.scale <= hi:
                series.setdefault(plate, {})[year] = float(v) * src.scale
                counts[year] = counts.get(year, 0) + 1
    full_years = sorted(y for y, n in counts.items() if n >= MIN_PROVINCE_MATCHES)
    if not full_years:
        raise ValueError(f"{src.metric}: hiçbir yılda yeterli il değeri yok ({len(plates)} il eşlendi)")
    latest = full_years[-1]
    # Seride yalnızca yeterince dolu yıllar kalsın
    series = {p: {y: v for y, v in s.items() if y in full_years} for p, s in series.items()}
    current = {p: s[latest] for p, s in series.items() if latest in s}
    return Fetched(current, latest, series)


def extract_reference(src: Source, path: Path) -> Fetched:
    """tools/fetch_reference.py çıktısı (resmi yüzölçümü + ADNKS nüfusu)."""
    ref = json.loads(path.read_text(encoding="utf-8"))
    year = int(ref["population_year"])
    values = {code: float(p[src.metric]) for code, p in ref["provinces"].items()}
    return Fetched(values, year, {code: {year: v} for code, v in values.items()})


async def fetch_source(client: PoliteClient, src: Source, name_index: dict[str, str]) -> Fetched:
    if src.format == "reference":
        res = extract_reference(src, ROOT / src.url)
    else:
        resp = await client.get(src.url)
        if src.format == "jsonstat":
            res = extract_jsonstat(src, resp.json(), name_index)
        else:
            header, rows = rows_from_response(src, resp)
            res = Fetched(extract_metric(src, header, rows, name_index))
    if len(res.values) < MIN_PROVINCE_MATCHES:
        raise ValueError(
            f"{src.metric}: yalnızca {len(res.values)} il eşleşti (en az {MIN_PROVINCE_MATCHES} gerekli)"
        )
    log.info("%s: %d il ayrıştırıldı (yıl: %s)", src.metric, len(res.values), res.year or "?")
    return res


# ---------------------------------------------------------------------------
# Senkronizasyon
# ---------------------------------------------------------------------------

@dataclass
class SyncResult:
    status: str
    metrics: list[str]
    message: str


@dataclass
class MetricUpdate:
    values: dict[str, float]
    year: int | None
    source: str
    official: bool
    series: dict[str, dict[int, float]]


def merge(results: list[tuple[Source, Fetched]]) -> dict[str, MetricUpdate]:
    """Aynı metrik için birden çok kaynak: güncel değer en yeni yıldan, seri hepsinden."""
    out: dict[str, MetricUpdate] = {}
    for src, res in results:
        name = src.source_name or urlsplit(src.url).netloc or src.url
        cur = out.get(src.metric)
        if cur is None:
            out[src.metric] = MetricUpdate(dict(res.values), res.year, name, src.official,
                                           {p: dict(s) for p, s in res.series.items()})
            continue
        for p, s in res.series.items():
            cur.series.setdefault(p, {}).update(s)
        if (res.year or 0) > (cur.year or 0):
            cur.values, cur.year, cur.official = dict(res.values), res.year, src.official
            cur.source = name if name == cur.source else f"{name}; {cur.source}"
        elif name not in cur.source:
            cur.source = f"{cur.source}; {name}"
    # doğal artış = doğum - ölüm (yıl yıl)
    if "birth_rate" in out and "death_rate" in out:
        b, d = out["birth_rate"], out["death_rate"]
        series = {
            p: {y: round(v - d.series[p][y], 2) for y, v in s.items() if y in d.series.get(p, {})}
            for p, s in b.series.items()
        }
        source = b.source if b.source == d.source else f"{b.source}; {d.source}"
        out["natural_growth_rate"] = MetricUpdate(
            {}, min(y for y in (b.year, d.year) if y) if (b.year or d.year) else None,
            source, b.official and d.official, series,
        )
    return out


async def sync(db_path: Path = DB_PATH, sources_path: Path = SOURCES_JSON) -> SyncResult:
    init_db(db_path)
    started = datetime.now(TZ).isoformat(timespec="seconds")
    sources = load_sources(sources_path)
    current = {p["plate_code"]: p for p in read_provinces(db_path)}
    name_index = {normalize_name(p["province_name"]): code for code, p in current.items()}

    ok: list[tuple[Source, Fetched]] = []
    errors: list[str] = []
    if sources:
        async with PoliteClient() as client:
            results = await asyncio.gather(
                *(fetch_source(client, s, name_index) for s in sources), return_exceptions=True
            )
        for src, res in zip(sources, results):
            if isinstance(res, BaseException):
                log.warning("Kaynak başarısız (%s): %s", src.metric, res)
                errors.append(f"{src.metric}: {res}")
            else:
                ok.append((src, res))
    updates = merge(ok)

    if not sources:
        status, msg = "no_sources", "data/sources.json içinde etkin kaynak yok; mevcut veri korunuyor"
    elif not ok:
        status, msg = "failed", "; ".join(errors)
    else:
        status = "success" if not errors else "partial"
        msg = "; ".join(errors) or "Tüm kaynaklar güncellendi"
        now = datetime.now(TZ).isoformat(timespec="seconds")
        for code, prov in current.items():
            changed = False
            for metric, upd in updates.items():
                if code in upd.values:
                    v = upd.values[code]
                    prov[metric] = int(round(v)) if metric == "population" else round(v, 2)
                    changed = True
            if changed:
                if prov.get("area_km2"):
                    prov["population_density"] = round(prov["population"] / prov["area_km2"], 1)
                if prov.get("birth_rate") is not None and prov.get("death_rate") is not None:
                    prov["natural_growth_rate"] = round(prov["birth_rate"] - prov["death_rate"], 2)
                prov["last_updated"] = now
                prov["source"] = "official"

    with closing(connect(db_path)) as conn, conn:
        if status in ("success", "partial"):
            conn.executemany(
                f"UPDATE provinces SET {','.join(f + '=:' + f for f in FIELDS[1:])} "
                "WHERE plate_code=:plate_code",
                list(current.values()),
            )
            for metric, upd in updates.items():
                conn.execute("DELETE FROM history WHERE metric=?", (metric,))
                conn.executemany(
                    "INSERT INTO history (plate_code, metric, year, value) VALUES (?,?,?,?)",
                    [(p, metric, y, round(v, 2)) for p, s in upd.series.items() for y, v in s.items()],
                )
                conn.execute(
                    "INSERT OR REPLACE INTO metric_meta (metric, source, year, official, updated_at) VALUES (?,?,?,?,?)",
                    (metric, upd.source, upd.year, int(upd.official), started),
                )
            if status == "success":  # kısmi eşitleme "güncel" sayılmaz
                conn.execute("INSERT OR REPLACE INTO info VALUES ('synced_at', ?)",
                             (datetime.now(TZ).isoformat(timespec="seconds"),))
        conn.execute(
            "INSERT INTO sync_log (started_at, finished_at, status, metrics, message) VALUES (?,?,?,?,?)",
            (started, datetime.now(TZ).isoformat(timespec="seconds"), status,
             json.dumps(sorted(updates)), msg[:2000]),
        )
    export_cache(db_path)
    log.info("Senkronizasyon: %s — %s", status, msg)
    return SyncResult(status, sorted(updates), msg)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _print_status() -> None:
    init_db()
    ls = last_sync()
    print(f"Mod            : {data_mode()}")
    print(f"Son eşitleme   : {synced_at() or '-'}")
    print(f"Son işlem      : {ls['status'] if ls else '-'} @ {ls['finished_at'] if ls else '-'}")
    if ls and ls.get("message"):
        print(f"Mesaj          : {ls['message']}")
    print(f"Etkin kaynak   : {len(load_sources())}")
    hist = read_history()
    years = sorted({y for p in hist.values() for s in p.values() for y in s})
    print(f"Seri yılları   : {years[0]}–{years[-1]}" if years else "Seri yılları   : -")
    for m, info in sorted(read_metric_meta().items()):
        tag = "resmi" if info["official"] else "yaklaşık"
        print(f"  {m:<20} {info['year'] or '-':<6} {tag:<9} {info['source']}")


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Demografi veri hattı")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--sync", action="store_true", help="Kaynakları çek ve DB'yi güncelle")
    g.add_argument("--status", action="store_true", help="Eşitleme durumunu göster")
    g.add_argument("--reset", action="store_true", help="DB'yi yedek veriden yeniden kur")
    g.add_argument("--freeze", action="store_true", help="Güncel DB'yi yedek veri dosyasına yaz")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(list(argv) if argv is not None else None)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if args.status:
        _print_status()
    elif args.reset:
        reset_db()
        print("DB yedek veriden yeniden kuruldu.")
    elif args.freeze:
        init_db()
        freeze_fallback()
        print(f"{FALLBACK_JSON.name} güncel DB'den yazıldı.")
    else:
        res = asyncio.run(sync())
        print(f"{res.status}: {res.message}")
        return 0 if res.status in ("success", "partial", "no_sources") else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
