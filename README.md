# Türkiye Nüfus Atlası

Türkiye'nin 81 ilinde nüfus, yoğunluk, doğum ve ölüm hızı, doğal artış, net göç ve ortanca yaş verilerini etkileşimli harita, sıralama listesi ve tablo olarak gösteren web sitesi. FastAPI ile sunulur, Vercel'de çalışır, ana ekrana eklenebilir (PWA) ve çevrimdışı açılır.

## Hızlı başlangıç

```bash
uv sync --all-extras
uv run uvicorn app:app --reload
```

Tarayıcı: http://localhost:8000. Testler: `uv run pytest`.

## Sayfalar ve API

| Adres | İçerik |
|---|---|
| `/` | Harita, sıralama, tablo görünümü |
| `/il/{il}` | Sunucuda üretilen il sayfası (örn. `/il/sanliurfa`; `/il/63` yönlendirir) |
| `/?g=net_migration_rate` | Gösterge seçili paylaşılabilir adres |
| `/api/v1/provinces?sort_by=population&order=desc&region=Ege&q=kara&limit=10&history=false` | Tüm iller |
| `/api/v1/provinces/{plaka veya il}` | Tek il, bölge sırası ve ortalamalar |
| `/api/v1/status` | Veri durumu: `live` (son 40 gün içinde eşitlendi), `cached`, `fallback` |
| `/api/docs` | OpenAPI belgeleri |
| `/sitemap.xml`, `/robots.txt`, `/manifest.webmanifest`, `/sw.js` | Arama motoru ve PWA dosyaları |

API yanıtları ETag taşır (değişmemişse `304`). HTML ve API, Vercel CDN'inde bir saat önbelleklenir.

## Veri kaynakları

| Gösterge | Kaynak | Yıl |
|---|---|---|
| Nüfus | TÜİK ADNKS (son yıl); 2020–2024 serisi Eurostat `demo_r_pjanaggr3` | 2025 |
| Yüzölçümü | HGM | |
| Kaba doğum ve ölüm hızı, net göç hızı | Eurostat `demo_r_gind3`, NUTS-3 (veriyi TÜİK iletir) | 2024 |
| Ortanca yaş | Eurostat `demo_r_pjanind3`, NUTS-3 | 2025 |

Eurostat'ın net göç hızı (`CNMIGRATRT`) iç ve dış göçü birlikte kapsar ve istatistiksel düzeltme içerir. Bu yüzden TÜİK'in yalnızca iç göç hızından farklıdır. Eurostat'ta 1 Ocak Y nüfusu, ADNKS'nin Y−1 yıl sonu nüfusudur; `year_offset: -1` bunu düzeltir.

### Veri hattı

```bash
uv run python tools/fetch_reference.py        # resmi yüzölçümü + son ADNKS nüfusu
uv run python turkstat_pipeline.py --sync     # kaynakları çek, data/demographics.db'yi güncelle
uv run python turkstat_pipeline.py --status   # durum, metrik kaynakları ve yılları
uv run python turkstat_pipeline.py --freeze   # DB'yi data/fallback_turkey_data.json'a yaz
uv run python turkstat_pipeline.py --reset    # DB'yi yedek veriden yeniden kur
```

Kaynaklar `data/sources.json` içinde tanımlıdır. Desteklenen biçimler: `jsonstat` (Eurostat API), `xlsx`/`xls`/`csv`/`html`/`json` (TÜİK tabloları) ve `reference` (yerel dosya). Her kaynak en az 70 ille eşleşmelidir; her metrik için en güncel ve yeterince dolu yıl seçilir. Yıllık seriler `history` tablosunda tutulur ve il ayrıntısında trend çizgisi olarak gösterilir.

İstemci `robots.txt`'ye uyar, aynı sunucuya en az 2 sn aralıkla istek atar, 429/5xx durumlarında üstel geri çekilmeyle (tenacity) en fazla 4 kez dener. TLS doğrulaması işletim sisteminin sertifika deposuyla (`truststore`) yapılır.

Yerelde sunucu `data/demographics.db` dosyasını izler; `--sync` sonrası yeniden başlatma gerekmez, açık sayfa da yeni veriyi alır.

## Vercel'e yayınlama

Vercel'de dosya sistemi salt okunurdur. Uygulama orada SQLite yerine depodaki `data/fallback_turkey_data.json` dosyasından okur (`VERCEL` ortam değişkeni varken otomatik).

1. Depoyu GitHub'a gönderin.
2. vercel.com'da **Add New → Project** ile depoyu seçin. FastAPI otomatik algılanır; ek ayar gerekmez.
3. **Settings → Environment Variables**: `SITE_URL` = sitenizin adresi (örn. `https://nufus-atlasi.vercel.app`). Kanonik adresler, sitemap ve paylaşım görseli bunu kullanır.

Veri güncellemesi GitHub Actions ile yapılır: `.github/workflows/sync-data.yml` her ayın 3'ünde kaynakları çeker, yedek veriyi günceller ve commit atar; Vercel yeni commit'i otomatik yayınlar. Elle çalıştırmak için GitHub'da **Actions → Veriyi resmi kaynaklarla eşitle → Run workflow**. İş akışının commit atabilmesi için **Settings → Actions → General → Workflow permissions: Read and write** seçili olmalıdır.

Vercel paketi yalnızca `fastapi` ve `jinja2` içerir; veri hattı bağımlılıkları (`pandas`, `httpx`...) `pipeline` ekstrasındadır ve yayına girmez.

## Proje yapısı

```
app.py                           FastAPI: sayfalar, API, sitemap, PWA
storage.py                       SQLite / JSON depolama (yalnızca standart kütüphane)
turkstat_pipeline.py             Veri hattı ve CLI
data/sources.json                Kaynak tanımları
data/fallback_turkey_data.json   Donmuş resmi veri (Vercel bu dosyadan çalışır)
data/official_reference.json     Resmi yüzölçümü + son ADNKS nüfusu
data/province_profiles.json      İl profilleri: simge, kültürel renk, rakım, alan kodu, ilçe, mutfak, gezilecek yerler, tarihçe
templates/index.html             Sayfa şablonu (il sayfaları dahil)
templates/_turkey_map.svg        81 il + komşu ülkeler SVG haritası (üretilir)
templates/_province_icons.svg    Emojisi olmayan 8 il için elle çizilmiş SVG simgeler
static/css, static/js            Arayüz (map_app.js) ve service worker (sw.js)
static/fonts, static/icons       Yerel yazı tipleri, ikonlar, paylaşım görseli
tools/                           Harita, referans veri, yazı tipi ve görsel üreticileri
tests/                           pytest
```

Yardımcı araçlar:

```bash
uv run python tools/build_map.py tr-cities.json countries-50m.json   # SVG haritayı yeniden üret
uv run python tools/fetch_fonts.py                        # yazı tiplerini indir
uv run --with pillow python tools/make_images.py          # PWA ikonları ve og.png
```

## Arayüz notları

- Tema: varsayılan açık tema beyaz zemin ve beyaz iller; karanlık tema siyah ve gri tonları. İlk açılışta cihaz ayarı (`prefers-color-scheme`), seçim yapılınca `localStorage` kullanılır. Geçiş yumuşak renk geçişiyle yapılır.
- Harita varsayılan olarak nötrdür; "Verileri renklendir" düğmesi seçili göstergenin renk rampasını açar.
- Her ilin bir kültürel rengi ve simgesi vardır (`data/province_profiles.json`). Renk, il panelinde vurgu rengidir; okunur tonu temaya göre OKLCH'de otomatik üretilir (metin 4,5:1, grafik 3:1).
- İl, ülke ve deniz adları ayrı bir HTML katmanındadır; yakınlaştırmada sabit boyutta kalır. Büyük iller önce yerleşir, çakışan etiket gizlenir, küçük iller yakınlaşınca görünür.
- Yakınlaştırma: tekerlek, sürükleme ve pinch; 1x ile 3x arası, il seçiminde en çok 2,2x. Harita ekrandan kaçmaz.
- İl paneli: Genel, Kültür ve lezzet, Gezilecek yerler, Demografi sekmeleri. Mobilde alttan açılan sayfa (tutamaktan aşağı çekince kapanır).
- Renk rampaları OKLCH'de üretildi ve dataviz doğrulayıcısından geçti. Doğal artış ve göçte sıfır çevresi nötr gri.
- Animasyonlar çoğunlukla `transform`/`opacity` ile yapılır. Yakınlaştırma HTML katmanında tek rAF döngüsüyle; iller açılışta batıdan doğuya sırayla belirir; üzerine gelinen il büyür ve simgesi zıplar; il paneli renk dalgası, sırayla gelen satırlar ve artarak sayan değerlerle açılır; sıralama listesi `translateY` ile yeniden dizilir. "Hareketi azalt" açıkken animasyonlar kapanır. Sıcak yollarda CSS özel özelliği yerine doğrudan `transform` yazılır.
- Erişilebilirlik: klavyeyle il gezinme, tablo görünümü, "tablo görünümüne geç" bağlantısı, `prefers-reduced-motion` desteği.
- Gizlilik: yazı tipleri kendi sunucumuzdan gelir; çerez ve üçüncü taraf istek yoktur.

## Lisanslar ve atıf

- Harita sınırları: [alpers/Turkey-Maps-GeoJSON](https://github.com/alpers/Turkey-Maps-GeoJSON), Apache License 2.0.
- Komşu ülkeler: [Natural Earth](https://www.naturalearthdata.com/) (kamu malı), [world-atlas](https://github.com/topojson/world-atlas) 2.0.2 üzerinden.
- İl profilleri: elle derlendi; il merkezi rakımı Vikipedi'den, en az iki kaynağın uzlaştığı ya da çelişkisiz tek kaynaktaki değer alınır, kaynaklar çelişirse boş bırakılır. Emin olunmayan alanlar panelde "veri yok" olarak görünür.
- Eurostat verisi: CC BY 4.0, kaynak Eurostat; Türkiye verisini TÜİK sağlar.
- Yüzölçümü ve son ADNKS nüfusu: Vikipedi "Türkiye'nin illeri" tablosu üzerinden (HGM, TÜİK).
- Yazı tipleri: Bricolage Grotesque ve Instrument Sans, SIL Open Font License 1.1 (`static/fonts/OFL-*.txt`).
