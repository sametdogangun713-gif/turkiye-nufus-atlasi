"""Veri depolama katmanı (yalnızca standart kütüphane).

Web uygulaması bu modülü kullanır; ağır bağımlılıklar (pandas, httpx...) yalnızca
veri hattında (turkstat_pipeline.py) gerekir. Böylece Vercel paketi küçük kalır.

İki arka uç:
  - SQLite  (data/demographics.db): yerel geliştirme ve --sync
  - JSON    (data/fallback_turkey_data.json): salt okunur ortamlar (Vercel)
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import unicodedata
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "demographics.db"
CACHE_JSON = DATA_DIR / "cache_turkey_demographics.json"
FALLBACK_JSON = DATA_DIR / "fallback_turkey_data.json"
SOURCES_JSON = DATA_DIR / "sources.json"
REFERENCE_JSON = DATA_DIR / "official_reference.json"

TZ = timezone(timedelta(hours=3))  # Europe/Istanbul (DST yok)
# Son başarılı eşitleme bu süreden yeniyse "live". Aylık otomatik eşitlemeyle uyumlu varsayılan.
LIVE_WINDOW = timedelta(days=float(os.getenv("LIVE_WINDOW_DAYS", "40")))

FIELDS = [
    "plate_code", "province_name", "region", "population", "area_km2",
    "population_density", "birth_rate", "death_rate", "natural_growth_rate",
    "net_migration_rate", "median_age", "last_updated", "source",
]
NUMERIC_FIELDS = [
    "population", "area_km2", "population_density", "birth_rate", "death_rate",
    "natural_growth_rate", "net_migration_rate", "median_age",
]
UNITS = {
    "population": "kişi", "area_km2": "km²", "population_density": "kişi/km²",
    "birth_rate": "‰", "death_rate": "‰", "natural_growth_rate": "‰",
    "net_migration_rate": "‰", "median_age": "yıl",
}


# ---------------------------------------------------------------------------
# İl adı normalizasyonu
# ---------------------------------------------------------------------------

_TR_MAP = str.maketrans("çğıöşüâîû", "cgiosuaiu")
ALIASES = {
    "afyon": "afyonkarahisar",
    "kmaras": "kahramanmaras",
    "maras": "kahramanmaras",
    "icel": "mersin",
    "urfa": "sanliurfa",
    "antep": "gaziantep",
}


def normalize_name(text: str) -> str:
    text = str(text).replace("İ", "i").replace("I", "ı").lower()
    text = unicodedata.normalize("NFC", text).translate(_TR_MAP)
    text = re.sub(r"[^a-z]", "", text)
    return ALIASES.get(text, text)


def slugify(name: str) -> str:
    """URL için il adı: "Şanlıurfa" -> "sanliurfa"."""
    return normalize_name(name)


# ---------------------------------------------------------------------------
# Yedek veri (JSON)
# ---------------------------------------------------------------------------

def load_fallback(path: Path = FALLBACK_JSON) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def mode_for(synced_at: str | None) -> str:
    """live: yakın zamanda resmi kaynakla eşitlendi | cached: daha eski | fallback: hiç eşitlenmedi."""
    if not synced_at:
        return "fallback"
    age = datetime.now(TZ) - datetime.fromisoformat(synced_at)
    return "live" if age < LIVE_WINDOW else "cached"


# ---------------------------------------------------------------------------
# SQLite
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS provinces (
    plate_code TEXT PRIMARY KEY,
    province_name TEXT NOT NULL,
    region TEXT NOT NULL,
    population INTEGER,
    area_km2 REAL,
    population_density REAL,
    birth_rate REAL,
    death_rate REAL,
    natural_growth_rate REAL,
    net_migration_rate REAL,
    median_age REAL,
    last_updated TEXT,
    source TEXT
);
CREATE TABLE IF NOT EXISTS history (
    plate_code TEXT NOT NULL,
    metric TEXT NOT NULL,
    year INTEGER NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (plate_code, metric, year)
);
CREATE TABLE IF NOT EXISTS metric_meta (
    metric TEXT PRIMARY KEY,       -- population, birth_rate, ...
    source TEXT NOT NULL,          -- okunur kaynak adı
    year INTEGER,                  -- güncel değerin referans yılı
    official INTEGER NOT NULL,     -- 1 = resmi istatistik, 0 = yaklaşık
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,          -- success | partial | failed | no_sources | seeded
    metrics TEXT,                  -- JSON: güncellenen metrikler
    message TEXT
);
CREATE TABLE IF NOT EXISTS info (key TEXT PRIMARY KEY, value TEXT);
"""


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(db_path: Path = DB_PATH, fallback: Path = FALLBACK_JSON) -> None:
    """Şemayı kurar; tablo boşsa yedek veriyle doldurur."""
    with closing(connect(db_path)) as conn, conn:
        conn.executescript(SCHEMA)
        if conn.execute("SELECT COUNT(*) FROM provinces").fetchone()[0] == 0:
            seed(conn, load_fallback(fallback))


def seed(conn: sqlite3.Connection, fb: dict[str, Any]) -> None:
    meta = fb["meta"]
    ts = meta["last_updated"]
    rows = [{**p, "last_updated": ts, "source": "fallback"} for p in fb["provinces"].values()]
    for table in ("provinces", "history", "metric_meta", "info"):
        conn.execute(f"DELETE FROM {table}")
    conn.executemany(
        f"INSERT INTO provinces ({','.join(FIELDS)}) VALUES ({','.join(':' + f for f in FIELDS)})",
        rows,
    )
    conn.executemany(
        "INSERT INTO history (plate_code, metric, year, value) VALUES (?,?,?,?)",
        [(code, m, int(y), v)
         for code, p in fb["provinces"].items()
         for m, series in (p.get("history") or {}).items()
         for y, v in series.items()],
    )
    conn.executemany(
        "INSERT INTO metric_meta (metric, source, year, official, updated_at) VALUES (?,?,?,?,?)",
        [(m, i["source"], i.get("year"), int(bool(i.get("official"))), ts)
         for m, i in meta.get("metrics", {}).items()],
    )
    if meta.get("synced_at"):
        conn.execute("INSERT INTO info VALUES ('synced_at', ?)", (meta["synced_at"],))
    now = datetime.now(TZ).isoformat(timespec="seconds")
    conn.execute(
        "INSERT INTO sync_log (started_at, finished_at, status, message) VALUES (?,?,?,?)",
        (now, now, "seeded", "Yedek veriden kuruldu"),
    )


def reset_db(db_path: Path = DB_PATH) -> None:
    with closing(connect(db_path)) as conn, conn:
        conn.executescript(SCHEMA)
        seed(conn, load_fallback())
    export_cache(db_path)


def read_provinces(db_path: Path = DB_PATH) -> list[dict[str, Any]]:
    with closing(connect(db_path)) as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM provinces ORDER BY plate_code")]


def read_history(db_path: Path = DB_PATH) -> dict[str, dict[str, dict[int, float]]]:
    out: dict[str, dict[str, dict[int, float]]] = {}
    with closing(connect(db_path)) as conn:
        for r in conn.execute("SELECT * FROM history ORDER BY year"):
            out.setdefault(r["plate_code"], {}).setdefault(r["metric"], {})[r["year"]] = r["value"]
    return out


def read_metric_meta(db_path: Path = DB_PATH) -> dict[str, dict[str, Any]]:
    with closing(connect(db_path)) as conn:
        return {
            r["metric"]: {"source": r["source"], "year": r["year"], "official": bool(r["official"])}
            for r in conn.execute("SELECT * FROM metric_meta")
        }


def synced_at(db_path: Path = DB_PATH) -> str | None:
    with closing(connect(db_path)) as conn:
        row = conn.execute("SELECT value FROM info WHERE key='synced_at'").fetchone()
    return row["value"] if row else None


def last_sync(db_path: Path = DB_PATH, successful_only: bool = False) -> dict[str, Any] | None:
    q = "SELECT * FROM sync_log"
    if successful_only:
        q += " WHERE status IN ('success','partial')"
    with closing(connect(db_path)) as conn:
        row = conn.execute(q + " ORDER BY id DESC LIMIT 1").fetchone()
    return dict(row) if row else None


def data_mode(db_path: Path = DB_PATH) -> str:
    return mode_for(synced_at(db_path))


# ---------------------------------------------------------------------------
# Veri kümesi: uygulamanın tükettiği tek biçim (iki arka uç için ortak)
# ---------------------------------------------------------------------------

def _derive_history(p: dict[str, Any], hist: dict[str, dict]) -> dict[str, dict[int, float]]:
    """Yoğunluk geçmişi nüfus geçmişinden türetilir."""
    hist = {m: {int(y): v for y, v in s.items()} for m, s in hist.items()}
    if "population" in hist and p.get("area_km2"):
        hist["population_density"] = {y: round(v / p["area_km2"], 1) for y, v in hist["population"].items()}
    return hist


def load_dataset(db_path: Path | None = DB_PATH) -> dict[str, Any]:
    """db_path None ise yalnızca JSON yedek veri okunur (salt okunur ortam)."""
    if db_path is None:
        fb = load_fallback()
        meta = fb["meta"]
        provinces = []
        for code, p in sorted(fb["provinces"].items()):
            row = {**p, "last_updated": meta["last_updated"], "source": "official" if meta.get("synced_at") else "fallback"}
            row["history"] = _derive_history(row, p.get("history") or {})
            provinces.append(row)
        return {
            "provinces": provinces,
            "metrics": meta.get("metrics", {}),
            "synced_at": meta.get("synced_at"),
            "mode": mode_for(meta.get("synced_at")),
            "last_sync": None,
            "backend": "json",
        }
    provinces = read_provinces(db_path)
    hist = read_history(db_path)
    for p in provinces:
        p["history"] = _derive_history(p, hist.get(p["plate_code"], {}))
    sa = synced_at(db_path)
    return {
        "provinces": provinces,
        "metrics": read_metric_meta(db_path),
        "synced_at": sa,
        "mode": mode_for(sa),
        "last_sync": last_sync(db_path),
        "backend": "sqlite",
    }


def export_cache(db_path: Path = DB_PATH, out: Path = CACHE_JSON) -> None:
    ds = load_dataset(db_path)
    payload = {
        "exported_at": datetime.now(TZ).isoformat(timespec="seconds"),
        **{k: ds[k] for k in ("mode", "synced_at", "last_sync", "metrics")},
        "provinces": {p["plate_code"]: p for p in ds["provinces"]},
    }
    _atomic_write(out, json.dumps(payload, ensure_ascii=False, indent=1))


def freeze_fallback(db_path: Path = DB_PATH, out: Path = FALLBACK_JSON) -> None:
    """Güncel DB'yi yedek veri dosyasına yazar. Vercel bu dosyadan çalışır."""
    provinces = read_provinces(db_path)
    hist = read_history(db_path)
    metrics = read_metric_meta(db_path)
    keep = [f for f in FIELDS if f not in ("last_updated", "source")]
    payload = {
        "meta": {
            "source": "fallback",
            "reference_year": max((m["year"] or 0) for m in metrics.values()) or None,
            "last_updated": datetime.now(TZ).isoformat(timespec="seconds"),
            "synced_at": synced_at(db_path),
            "units": UNITS,
            "metrics": metrics,
            "note": "turkstat_pipeline.py --freeze ile DB'den üretildi.",
        },
        "provinces": {
            p["plate_code"]: {
                **{k: p[k] for k in keep},
                "history": {m: {str(y): v for y, v in s.items()} for m, s in hist.get(p["plate_code"], {}).items()},
            }
            for p in provinces
        },
    }
    _atomic_write(out, json.dumps(payload, ensure_ascii=False, indent=1))


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
