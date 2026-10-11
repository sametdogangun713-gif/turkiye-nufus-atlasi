"""Yazı tiplerini Google Fonts'tan bir kez indirip yerelde barındırır (KVKK: kullanıcı IP'si
Google'a gitmez). Yalnızca latin + latin-ext alt kümeleri (Türkçe karakterler latin-ext'te).

Çıktı: static/fonts/*.woff2 ve static/fonts/fonts.css
Kullanım: uv run --extra pipeline python tools/fetch_fonts.py
"""

from __future__ import annotations

import re
import ssl
from pathlib import Path

import httpx
import truststore

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "static" / "fonts"
CSS_URL = (
    "https://fonts.googleapis.com/css2?"
    "family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Instrument+Sans:wght@400..700&display=swap"
)
# woff2 + unicode-range döndürmesi için modern tarayıcı UA'sı gerekir
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
KEEP = {"latin", "latin-ext"}
LICENSES = {
    "OFL-BricolageGrotesque.txt": "https://raw.githubusercontent.com/google/fonts/main/ofl/bricolagegrotesque/OFL.txt",
    "OFL-InstrumentSans.txt": "https://raw.githubusercontent.com/google/fonts/main/ofl/instrumentsans/OFL.txt",
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with httpx.Client(verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT), timeout=30) as c:
        css = c.get(CSS_URL, headers={"User-Agent": UA}).raise_for_status().text
        blocks = re.findall(r"/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*{[^}]+})", css)
        out_css = []
        for subset, block in blocks:
            if subset not in KEEP:
                continue
            family = re.search(r"font-family:\s*'([^']+)'", block).group(1)
            url = re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)
            name = f"{family.replace(' ', '')}-{subset}.woff2"
            (OUT / name).write_bytes(c.get(url).raise_for_status().content)
            out_css.append(block.replace(url, f"/static/fonts/{name}"))
            print(f"{name}: {(OUT / name).stat().st_size // 1024} KB")
        (OUT / "fonts.css").write_text(
            "/* tools/fetch_fonts.py ile üretildi. Lisans: SIL OFL 1.1 (bkz. OFL-*.txt) */\n"
            + "\n".join(out_css) + "\n",
            encoding="utf-8",
        )
        for fname, url in LICENSES.items():
            (OUT / fname).write_text(c.get(url).raise_for_status().text, encoding="utf-8")


if __name__ == "__main__":
    main()
