/* =========================================================================
   Türkiye Nüfus Atlası — istemci
   Bölümler: Biçim · Renk · Metrikler · Ölçek · Profiller · Görünüm (zoom) ·
             Harita · Etiketler · İpucu · Lejant · Sekmeler · Başlık ·
             Sıralama · Detay · Arama · Durum · Başlatma
   Performans ilkeleri:
     - Hareket = transform/opacity. Yakınlaştırma HTML katmanında; etiketler
       ayrı bir HTML katmanında translate3d ile taşınır (yazı her ölçekte net).
     - Fare tekerleği, sürükleme ve pinch tek rAF döngüsüne yazar.
     - Sıralama listesi mutlak konumlu; yeniden sıralama = translateY, DOM
       sırası ve düzen hesabı değişmez.
     - mousemove yalnızca hedefi kaydeder; yazımlar tek rAF döngüsünde.
   ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);
const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
let motionOK = !motionQuery.matches;
motionQuery.addEventListener?.("change", (e) => (motionOK = !e.matches));
const mobile = matchMedia("(max-width: 860px)");
const raf2 = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------------- Biçim */
const nf = new Intl.NumberFormat("tr-TR");
const nf1 = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nfCompact = new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 });

function people(v) {
  if (v >= 1e6) return `${nf1.format(v / 1e6)} milyon`;
  if (v >= 1e4) return `${nf.format(Math.round(v / 1e3))} bin`;
  return nf.format(Math.round(v));
}
const signed = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + nf1.format(Math.abs(v));

function fmt(metric, v, mode = "full") {
  if (v == null || Number.isNaN(v)) return "—";
  switch (metric) {
    case "population": return mode === "short" ? nfCompact.format(v) : nf.format(Math.round(v));
    case "population_density": return nf.format(Math.round(v));
    case "natural_growth_rate":
    case "net_migration_rate": return signed(v);
    default: return nf1.format(v);
  }
}

/** Türkçe bulunma eki: Sinop'ta, Hakkari'de, Şanlıurfa'da */
function loc(word) {
  const vowels = word.match(/[aeıioöuü]/gi) || ["a"];
  const back = /[aıou]/i.test(vowels[vowels.length - 1]);
  const hard = /[çfhkpsşt]$/i.test(word);
  return `${word}'${hard ? "t" : "d"}${back ? "a" : "e"}`;
}

const trFold = (s) => s.replace(/I/g, "ı").replace(/İ/g, "i").toLocaleLowerCase("tr-TR")
  .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* -------------------------------------------------------------------- Renk */
// İl rengi her temada okunur kalsın: OKLCH'de açıklık, zemine karşı hedef
// kontrasta ulaşana dek kaydırılır (açık temada koyulaşır, koyu temada açılır).
const Color = {
  rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255); },
  hex(rgb) { return "#" + rgb.map((c) => Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, "0")).join(""); },
  lin: (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4),
  gam: (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055),
  lum(hex) { const [r, g, b] = this.rgb(hex).map(this.lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; },
  contrast(a, b) { const la = this.lum(a), lb = this.lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); },
  toOklch(hex) {
    const [r, g, b] = this.rgb(hex).map(this.lin);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return [L, Math.hypot(A, B), Math.atan2(B, A)];
  },
  fromOklch(L, C, h) {
    for (let c = C; c >= 0; c -= 0.004) { // renk uzayı dışına taşarsa doygunluğu azalt
      const A = c * Math.cos(h), B = c * Math.sin(h);
      const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
      const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
      const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
      const rgb = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
      ];
      if (rgb.every((v) => v >= -0.001 && v <= 1.001)) return this.hex(rgb.map(this.gam));
    }
    return this.hex([L, L, L].map(this.gam));
  },
  /** Zemine karşı en az `min` kontrastlı ton. Yeterliyse rengin kendisi döner. */
  readable(hex, bg, min = 4.5) {
    if (this.contrast(hex, bg) >= min) return hex;
    let [L, C, h] = this.toOklch(hex);
    const dir = this.lum(bg) > 0.4 ? -1 : 1;
    for (let i = 0; i < 100; i++) {
      L = clamp(L + dir * 0.01, 0, 1);
      const out = this.fromOklch(L, C, h);
      if (this.contrast(out, bg) >= min || L === 0 || L === 1) return out;
    }
    return hex;
  },
};

/* --------------------------------------------------------------- Metrikler */
// Rampalar OKLCH'den üretildi ve dataviz doğrulayıcısından geçti
// (tek ton, monoton açıklık, açık uç zemine karşı >= 2:1).
const RAMPS = {
  light: {
    cobalt: ["#85a9eb", "#6691e2", "#4b7ad3", "#3664bd", "#264f9e", "#1d3d7b", "#162c57"],
    turq: ["#6db9b5", "#3ba5a2", "#00918e", "#007b78", "#006462", "#004d4c", "#003736"],
    red: ["#e39082", "#d77162", "#c55546", "#ad3d30", "#902c21", "#702118", "#4f1a13"],
    saffron: ["#cda069", "#bd873c", "#ab6e00", "#955900", "#7b4600", "#5f3500", "#432600"],
    violet: ["#b29dda", "#9e82ce", "#896abd", "#7454a7", "#5f418b", "#49326c", "#34244c"],
    arms: { red: ["#e39082", "#be4d3e", "#6d352c"], turq: ["#6db9b5", "#008a87", "#145250"], cobalt: ["#85a9eb", "#4473cd", "#2e4774"] },
    neutral: "#c9ced5",
  },
  dark: {
    cobalt: ["#34538e", "#4069b6", "#507fd9", "#6597f5", "#81b1ff", "#a3cbff", "#c7e6ff"],
    turq: ["#056260", "#007c79", "#009693", "#28afab", "#58c6c2", "#88ddd9", "#b6f2ef"],
    red: ["#853c31", "#a9493b", "#cb5a4b", "#e77260", "#fd8e7d", "#ffaf9f", "#ffd1c4"],
    saffron: ["#734c0f", "#935f01", "#b0730b", "#ca8b2e", "#e1a556", "#f3c182", "#ffdeb1"],
    violet: ["#5d497f", "#765ba2", "#8e6fc3", "#a686de", "#bea0f3", "#d5bdff", "#ebdbff"],
    arms: { red: ["#954a3f", "#e5705f", "#ffbdb1"], turq: ["#1f716e", "#25adaa", "#a3dedb"], cobalt: ["#42629e", "#6496f4", "#b4d2ff"] },
    neutral: "#4a4b50",
  },
};

const METRICS = {
  population: {
    tab: "Nüfus", label: "Nüfus", unit: "kişi", ramp: "cobalt", log: true, by: "Nüfusa göre iller",
    headline: (hi, lo) => `${hi.province_name} ${people(hi.population)}, ${lo.province_name} ${people(lo.population)} kişi.`,
    sub: (n, s) => `En kalabalık ve en az nüfuslu il. Türkiye'nin toplam nüfusu ${people(n.population)}; bunun yüzde ${nf1.format((s.hi.population / n.population) * 100)}'i ${loc(s.hi.province_name)} yaşıyor.`,
  },
  population_density: {
    tab: "Yoğunluk", label: "Nüfus yoğunluğu", unit: "kişi/km²", ramp: "violet", log: true, by: "Yoğunluğa göre iller",
    headline: (hi, lo) => `${loc(hi.province_name)} kilometrekareye ${nf.format(Math.round(hi.population_density))}, ${loc(lo.province_name)} ${nf.format(Math.round(lo.population_density))} kişi düşüyor.`,
    sub: (n) => `En yoğun ve en seyrek il. Türkiye ortalaması kilometrekareye ${nf.format(Math.round(n.population_density))} kişi.`,
  },
  birth_rate: {
    tab: "Doğum", label: "Doğum hızı", unit: "‰", ramp: "turq", by: "Doğum hızına göre iller",
    headline: (hi, lo) => `${loc(hi.province_name)} doğum hızı binde ${nf1.format(hi.birth_rate)}, ${loc(lo.province_name)} binde ${nf1.format(lo.birth_rate)}.`,
    sub: (n) => `Bin kişi başına bir yılda doğan bebek sayısı. Türkiye ortalaması binde ${nf1.format(n.birth_rate)}.`,
  },
  death_rate: {
    tab: "Ölüm", label: "Ölüm hızı", unit: "‰", ramp: "red", by: "Ölüm hızına göre iller",
    headline: (hi, lo) => `${loc(hi.province_name)} ölüm hızı binde ${nf1.format(hi.death_rate)}, ${loc(lo.province_name)} binde ${nf1.format(lo.death_rate)}.`,
    sub: (n) => `Bin kişi başına bir yıldaki ölüm sayısı. Yaşlı nüfusu fazla olan illerde yükselir. Türkiye ortalaması binde ${nf1.format(n.death_rate)}.`,
  },
  natural_growth_rate: {
    tab: "Doğal artış", label: "Doğal artış hızı", unit: "‰", diverging: ["red", "turq"], threshold: 1, by: "Doğal artışa göre iller",
    headline: (hi, lo) => `${hi.province_name} binde ${signed(hi.natural_growth_rate)} ile önde, ${lo.province_name} binde ${signed(lo.natural_growth_rate)} ile sonda.`,
    sub: (n, s) => `Doğum hızı ile ölüm hızı arasındaki fark. ${s.neg ? `${s.neg} ilde ölümler doğumları geçiyor.` : "Her ilde doğumlar ölümlerden fazla."}`,
  },
  net_migration_rate: {
    tab: "Göç", label: "Net göç hızı", unit: "‰", diverging: ["red", "cobalt"], threshold: 1, by: "Net göçe göre iller",
    headline: (hi, lo) => `${hi.province_name} binde ${nf1.format(hi.net_migration_rate)} göç aldı, ${lo.province_name} binde ${nf1.format(Math.abs(lo.net_migration_rate))} göç verdi.`,
    sub: (n, s) => `Bin kişi başına gelen ile giden farkı; iç ve dış göç birlikte. ${s.pos} il göç alıyor, ${s.neg} il göç veriyor.`,
  },
  median_age: {
    tab: "Yaş", label: "Ortanca yaş", unit: "yıl", ramp: "saffron", by: "Ortanca yaşa göre iller",
    headline: (hi, lo) => `${loc(lo.province_name)} ortanca yaş ${nf1.format(lo.median_age)}, ${loc(hi.province_name)} ${nf1.format(hi.median_age)}.`,
    sub: (n) => `Nüfusun yarısı bu yaştan genç, yarısı yaşlı. Türkiye ortalaması ${nf1.format(n.median_age)}.`,
  },
};
const METRIC_KEYS = Object.keys(METRICS);

/* ------------------------------------------------------------------- Durum */
const state = {
  provinces: [], byCode: new Map(), meta: null, lastUpdated: null,
  metric: "population", order: "desc", scale: null,
  hovered: null, selected: null, colorize: false,
  theme: () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
};

const Api = {
  async get(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  },
  provinces: () => Api.get("/api/v1/provinces?sort_by=plate_code"),
  status: () => Api.get("/api/v1/status", { cache: "no-cache" }),
};

/* ------------------------------------------------------------------- Ölçek */
function quantileBreaks(sorted, k) {
  const out = [];
  for (let i = 1; i < k; i++) out.push(sorted[Math.floor((i * sorted.length) / k)]);
  return [...new Set(out)];
}
function classesFrom(vals, k, colors) {
  const b = quantileBreaks(vals, k);
  const bounds = [vals[0], ...b, vals[vals.length - 1]];
  const pick = (i, n) => colors[Math.round((i * (colors.length - 1)) / Math.max(1, n - 1))];
  return bounds.slice(0, -1).map((min, i) => ({ min, max: bounds[i + 1], color: pick(i, bounds.length - 1) }));
}

/** Sıralı: tek ton, 7 kantil sınıf. Iraksak: iki ton + nötr gri orta sınıf. */
function buildScale(metric) {
  const m = METRICS[metric];
  const R = RAMPS[state.theme()];
  const vals = state.provinces.map((p) => p[metric]).filter((v) => v != null).sort((a, b) => a - b);
  let classes;
  if (m.diverging) {
    const t = m.threshold;
    const neg = vals.filter((v) => v < -t), mid = vals.filter((v) => v >= -t && v < t), pos = vals.filter((v) => v >= t);
    const [negArm, posArm] = [R.arms[m.diverging[0]], R.arms[m.diverging[1]]];
    classes = [];
    if (neg.length) {
      const c = classesFrom(neg, Math.min(3, Math.max(1, Math.floor(neg.length / 4))), [...negArm].reverse());
      c[c.length - 1].max = -t;
      classes.push(...c);
    }
    if (mid.length) classes.push({ min: -t, max: t, color: R.neutral });
    if (pos.length) {
      const c = classesFrom(pos, Math.min(3, Math.max(1, Math.floor(pos.length / 4))), posArm);
      c[0].min = t;
      classes.push(...c);
    }
  } else {
    classes = classesFrom(vals, 7, R[m.ramp]);
  }
  const classify = (v) => {
    if (v == null) return -1;
    for (let i = 0; i < classes.length; i++) {
      if (v >= classes[i].min && (v < classes[i].max || i === classes.length - 1)) return i;
    }
    return v < classes[0].min ? 0 : classes.length - 1;
  };
  classes.forEach((c) => (c.count = 0));
  vals.forEach((v) => classes[classify(v)].count++);
  return { metric, classes, classify, min: vals[0], max: vals[vals.length - 1] };
}

/* --------------------------------------------------------------- Profiller */
// data/province_profiles.json: simge, kültürel renk ve gerekçesi, rakım, alan
// kodu, ilçe sayısı, yemek, ürün, gezilecek yer, etkinlik, tarihçe.
const Profiles = {
  data: {},
  init() {
    try { this.data = JSON.parse($("#profiles-data")?.textContent || "{}").provinces || {}; } catch { this.data = {}; }
  },
  get: (code) => Profiles.data[code] || {},
  color: (code) => Profiles.data[code]?.color || "#7E8AA0",
  /** Simge HTML'i: emoji ya da elle çizilmiş SVG (#ico-*). */
  symbol(code, cls = "") {
    const p = this.get(code);
    if (p.icon) return `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#ico-${esc(p.icon)}"/></svg>`;
    return `<span class="emo ${cls}" aria-hidden="true">${esc(p.emoji || "•")}</span>`;
  },
  /** Temaya göre okunur vurgu tonları: metin (4,5:1) ve grafik (3:1). */
  accents(code) {
    const base = this.color(code);
    const cs = getComputedStyle(document.documentElement);
    const sheet = cs.getPropertyValue("--sheet").trim() || "#ffffff";
    return { base, text: Color.readable(base, sheet, 4.5), ui: Color.readable(base, sheet, 3) };
  },
};

/* --------------------------------------------------------- Görünüm (zoom) */
// Harita katmanı (map-stage) translate+scale ile taşınır. Sınırlar: en az 1x
// (tüm harita), en çok 3x. Harita hiçbir zaman ekrandan kaçmaz: çizim alanı
// görünür alandan küçükse ortalanır, büyükse kenarları dışarı itilmez.
const View = {
  s: 1, x: 0, y: 0, MIN: 1, MAX: 3, FLY_MAX: 2.2,
  anim: null, raf: 0, pointers: new Map(), dragEnd: 0, saved: null, sheetOverlap: 0,

  init() {
    this.stage = $("#map-stage");
    this.clip = $("#map-clip");
    this.svg = $("#turkey-map");
    this.vb = this.svg.viewBox.baseVal;
    this.measure();
    // Harita alanının boyutu ızgara düzeni, yazı tipleri ve pencereyle değişir:
    // pencere olayı yerine alanın kendisi izlenir.
    const onResize = () => {
      if (state.tabular) return;
      const { W, H } = this;
      this.measure();
      if (W === this.W && H === this.H) return;
      this.sheetOverlap = state.selected ? sheetOverlap() : 0;
      if (state.selected) this.flyTo(state.selected, true);
      else this.apply(this.clampView(W ? { s: this.s, x: this.x * (this.W / W), y: this.y * (this.H / (H || 1)) } : this));
      Labels.layout();
    };
    if ("ResizeObserver" in window) new ResizeObserver(onResize).observe(this.clip);
    else addEventListener("resize", onResize, { passive: true });

    this.clip.addEventListener("wheel", (e) => {
      if (state.tabular) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const k = e.ctrlKey ? 0.01 : 0.0022; // ctrl+tekerlek = dokunmatik yüzeyde iki parmak
      const from = this.anim?.kind === "glide" ? this.anim.to : this.cur();
      const p = this.local(e.clientX, e.clientY);
      this.glide(this.zoomAt(from, from.s * Math.exp(-e.deltaY * unit * k), p));
    }, { passive: false });

    this.clip.addEventListener("pointerdown", (e) => this.down(e));
    this.clip.addEventListener("pointermove", (e) => this.move(e));
    this.clip.addEventListener("pointerup", (e) => this.up(e));
    this.clip.addEventListener("pointercancel", (e) => this.up(e));

    $("#zoom-in").addEventListener("click", () => this.step(1.6));
    $("#zoom-out").addEventListener("click", () => this.step(1 / 1.6));
    $("#zoom-reset").addEventListener("click", () => (state.selected ? deselect() : this.home()));
  },

  cur() { return { s: this.s, x: this.x, y: this.y }; },

  /** Ölçümler yalnızca açılışta ve boyut değişince (düzen okuması sıcak yolda yok). */
  measure() {
    this.W = this.stage.offsetWidth;
    this.H = this.stage.offsetHeight;
    this.L = this.stage.offsetLeft;
    this.T = this.stage.offsetTop;
    const vb = this.vb;
    this.k = Math.min(this.W / vb.width, this.H / vb.height);
    // map birimi -> sahne pikseli: px = ox + mx * k
    this.ox = (this.W - vb.width * this.k) / 2 - vb.x * this.k;
    this.oy = (this.H - vb.height * this.k) / 2 - vb.y * this.k;
    this.d = {
      x0: (this.W - vb.width * this.k) / 2, x1: (this.W + vb.width * this.k) / 2,
      y0: (this.H - vb.height * this.k) / 2, y1: (this.H + vb.height * this.k) / 2,
    };
    this.rect = this.clip.getBoundingClientRect();
  },

  /** Görünür alan (sahne koordinatı). Mobilde alt sayfa haritanın altını örter. */
  viewport() {
    return { x0: 0, x1: this.W, y0: 0, y1: Math.max(this.H * 0.3, this.H - this.sheetOverlap) };
  },

  local(cx, cy) {
    this.rect = this.clip.getBoundingClientRect();
    return { x: cx - this.rect.left - this.L, y: cy - this.rect.top - this.T };
  },

  clampView(v) {
    const s = clamp(v.s, this.MIN, this.MAX), vp = this.viewport(), d = this.d;
    const axis = (pos, d0, d1, v0, v1) => {
      const size = s * (d1 - d0);
      if (size <= v1 - v0) return (v0 + v1) / 2 - (s * (d0 + d1)) / 2;
      return clamp(pos, v1 - s * d1, v0 - s * d0);
    };
    return { s, x: axis(v.x, d.x0, d.x1, vp.x0, vp.x1), y: axis(v.y, d.y0, d.y1, vp.y0, vp.y1) };
  },

  zoomAt(from, s2, p) {
    s2 = clamp(s2, this.MIN, this.MAX);
    const r = s2 / from.s;
    return this.clampView({ s: s2, x: p.x - (p.x - from.x) * r, y: p.y - (p.y - from.y) * r });
  },

  /** Doğrudan yaz: sahne dönüşümü, çizgi kalınlığı telafisi, etiket konumları. */
  apply(v) {
    this.s = v.s; this.x = v.x; this.y = v.y;
    this.stage.style.transform = `translate3d(${v.x.toFixed(2)}px, ${v.y.toFixed(2)}px, 0) scale(${v.s.toFixed(4)})`;
    this.svg.style.setProperty("--zk", v.s.toFixed(3));
    Labels.position();
    if (Math.abs(v.s - Labels.lastS) / v.s > 0.06) Labels.layout();
    const zoomed = v.s > 1.01;
    if (zoomed !== this.zoomed) {
      this.zoomed = zoomed;
      this.clip.classList.toggle("zoomed", zoomed);
    }
    const resetOn = zoomed || !!state.selected;
    $("#zoom-reset").hidden = !resetOn;
    $("#zoom-in").disabled = v.s >= this.MAX - 0.01;
    $("#zoom-out").disabled = v.s <= this.MIN + 0.01;
  },

  stop() { cancelAnimationFrame(this.raf); this.raf = 0; this.anim = null; },

  /** Tekerlek: hedefe üstel yaklaşma (yumuşak, ardışık tıkları biriktirir). */
  glide(to) {
    if (!motionOK) { this.stop(); this.apply(to); Labels.layout(); return; }
    this.anim = { kind: "glide", to };
    this.loop();
  },

  /** Uçuş: süreli geçiş (il seçimi, sıfırlama, düğmeler). */
  tween(to, dur = 850) {
    if (!motionOK || dur === 0) { this.stop(); this.apply(to); Labels.layout(); return; }
    this.anim = { kind: "tween", from: this.cur(), to, t0: performance.now(), dur };
    this.loop();
  },

  loop() {
    if (this.raf) return;
    const tick = (now) => {
      const a = this.anim;
      if (!a) { this.raf = 0; return; }
      let done = false, v;
      if (a.kind === "glide") {
        const k = 0.24;
        v = { s: this.s + (a.to.s - this.s) * k, x: this.x + (a.to.x - this.x) * k, y: this.y + (a.to.y - this.y) * k };
        done = Math.abs(a.to.s - v.s) < 0.002 && Math.abs(a.to.x - v.x) < 0.3 && Math.abs(a.to.y - v.y) < 0.3;
        if (done) v = a.to;
      } else {
        const t = Math.min(1, (now - a.t0) / a.dur);
        const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; // easeInOutCubic
        // ölçek geometrik ilerler: yakınlaşma hissi doğrusal olur
        const s = a.from.s * (a.to.s / a.from.s) ** e;
        v = { s, x: a.from.x + (a.to.x - a.from.x) * e, y: a.from.y + (a.to.y - a.from.y) * e };
        done = t >= 1;
      }
      this.apply(v);
      if (done) { this.anim = null; this.raf = 0; Labels.layout(); return; }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },

  step(f) {
    const vp = this.viewport();
    const from = this.anim?.to || this.cur();
    this.tween(this.zoomAt(from, from.s * f, { x: (vp.x0 + vp.x1) / 2, y: (vp.y0 + vp.y1) / 2 }), 380);
  },

  home() { this.tween(this.clampView({ s: 1, x: 0, y: 0 }), 700); },

  /** İle uç: il görünür alanın ortasına, en çok FLY_MAX kat. */
  flyTo(code, instant = false) {
    const path = MapView.paths.get(code);
    if (!path) return;
    const bb = path.getBBox(), vp = this.viewport();
    const w = Math.max(bb.width, 8) * this.k, h = Math.max(bb.height, 8) * this.k;
    const s = clamp(Math.min(((vp.x1 - vp.x0) * 0.42) / w, ((vp.y1 - vp.y0) * 0.5) / h), 1.15, this.FLY_MAX);
    const cx = this.ox + (bb.x + bb.width / 2) * this.k, cy = this.oy + (bb.y + bb.height / 2) * this.k;
    const to = this.clampView({ s, x: (vp.x0 + vp.x1) / 2 - s * cx, y: (vp.y0 + vp.y1) / 2 - s * cy });
    this.tween(to, instant ? 0 : 900);
  },

  /* Sürükleme ve pinch. Yakalama ancak sürükleme başlayınca alınır: aksi halde
     tıklama hedefi kap olurdu ve il seçilemezdi. */
  down(e) {
    if (state.tabular || e.button > 0 || e.target.closest("button, a, input, .legend")) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.gesture = this.pointers.size === 1
      ? { type: "pan", sx: e.clientX, sy: e.clientY, v: this.cur(), moved: false }
      : this.pinchStart();
  },
  pinchStart() {
    const [a, b] = [...this.pointers.values()];
    return { type: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: this.local((a.x + b.x) / 2, (a.y + b.y) / 2), v: this.cur(), moved: true };
  },
  move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = this.gesture;
    if (!g) return;
    if (g.type === "pan") {
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (!g.moved) {
        if (Math.hypot(dx, dy) < 6 || (this.s <= 1.01 && e.pointerType === "mouse")) return;
        g.moved = true;
        this.clip.setPointerCapture?.(e.pointerId);
        this.clip.classList.add("dragging");
        hover(null);
      }
      this.stop();
      this.apply(this.clampView({ s: g.v.s, x: g.v.x + dx, y: g.v.y + dy }));
    } else if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = this.local((a.x + b.x) / 2, (a.y + b.y) / 2);
      const s2 = clamp(g.v.s * (d / g.d), this.MIN, this.MAX), r = s2 / g.v.s;
      this.stop();
      this.apply(this.clampView({ s: s2, x: mid.x - (g.mid.x - g.v.x) * r, y: mid.y - (g.mid.y - g.v.y) * r }));
    }
  },
  up(e) {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.gesture?.moved) this.dragEnd = performance.now();
    if (this.pointers.size === 1) {
      // pinch bitti, kalan parmakla kaydırmaya devam
      const [p] = this.pointers.values();
      this.gesture = { type: "pan", sx: p.x, sy: p.y, v: this.cur(), moved: true };
    } else if (!this.pointers.size) {
      this.gesture = null;
      this.clip.classList.remove("dragging");
      Labels.layout();
    }
  },
  justDragged() { return performance.now() - this.dragEnd < 260; },
};

/* ------------------------------------------------------------------ Harita */
const MapView = {
  paths: new Map(), anims: [],

  init() {
    this.svg = $("#turkey-map");
    this.group = $("#provinces");
    const viewport = $("#map-viewport");

    this.group.insertAdjacentHTML("afterend", `
      <g id="select-layer"><use id="select-use"/></g>
      <g id="hover-layer"><use id="hover-shadow"/><use id="hover-top"/></g>`);
    this.selUse = $("#select-use");
    this.shadow = $("#hover-shadow");
    this.top = $("#hover-top");

    for (const path of this.group.children) {
      const p = state.byCode.get(path.id);
      this.paths.set(path.id, path);
      if (!p) continue;
      path.dataset.province = p.province_name;
      path.setAttribute("tabindex", "0");
      path.setAttribute("role", "button");
      path.setAttribute("aria-label", `${p.province_name}, ${p.region} Bölgesi`);
    }

    const codeOf = (e) => e.target.closest?.(".province")?.id;
    const g = this.group;
    g.addEventListener("pointerover", (e) => { const c = codeOf(e); if (c && !View.gesture?.moved) hover(c, e); });
    g.addEventListener("pointerleave", () => hover(null));
    g.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") Tooltip.follow(e.clientX, e.clientY); }, { passive: true });
    g.addEventListener("click", (e) => {
      const c = codeOf(e);
      if (!c || View.justDragged()) return;
      if (c === state.selected) return;
      select(c, { zoom: true });
    });
    g.addEventListener("focusin", (e) => {
      const c = codeOf(e);
      if (!c) return;
      const r = e.target.getBoundingClientRect();
      Tooltip.follow(r.left + r.width / 2, r.top + r.height / 2, true);
      hover(c, { pointerType: "keyboard" });
    });
    g.addEventListener("focusout", () => hover(null));
    g.addEventListener("keydown", (e) => {
      const c = codeOf(e);
      if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(c, { zoom: true }); }
    });
    void viewport;
  },

  /** Açılış: iller batıdan doğuya sırayla belirir (yalnızca opacity/transform). */
  intro() {
    if (!motionOK) return;
    const xs = [...this.paths.values()].map((p) => +p.dataset.lx);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    for (const p of this.paths.values()) {
      p.style.animationDelay = `${Math.round(((+p.dataset.lx - lo) / (hi - lo)) * 700 + Math.random() * 120)}ms`;
    }
    this.svg.classList.add("intro");
    setTimeout(() => {
      this.svg.classList.remove("intro");
      for (const p of this.paths.values()) p.style.animationDelay = "";
    }, 1700);
  },

  /** Hover: gölge + hafifçe büyüyen üst kopya, yalnızca transform/opacity (WAAPI). */
  setHover(code) {
    this.anims.forEach((a) => a.cancel());
    const d = motionOK ? 1 : 0;
    if (!code) {
      this.anims = [
        this.top.animate([{ opacity: 1, transform: "scale(1.045)" }, { opacity: 0, transform: "scale(1)" }], { duration: 160 * d, easing: "ease-out", fill: "forwards" }),
        this.shadow.animate([{ opacity: 0.2, transform: "translate(0, 3px) scale(1.045)" }, { opacity: 0, transform: "none" }], { duration: 160 * d, easing: "ease-out", fill: "forwards" }),
      ];
      return;
    }
    this.top.setAttribute("href", `#${code}`);
    this.shadow.setAttribute("href", `#${code}`);
    // Nötr haritada üzerine gelinen il kendi kültürel rengine bürünür
    if (state.colorize) this.top.style.removeProperty("--p-fill");
    else this.top.style.setProperty("--p-fill", `color-mix(in oklab, ${Profiles.color(code)} 34%, var(--prov))`);
    const ease = "cubic-bezier(0.34, 1.4, 0.64, 1)";
    this.anims = [
      this.top.animate([{ opacity: 0.6, transform: "scale(1)" }, { opacity: 1, transform: "scale(1.045)" }], { duration: 260 * d, easing: ease, fill: "forwards" }),
      this.shadow.animate([{ opacity: 0, transform: "none" }, { opacity: 0.2, transform: "translate(0, 3px) scale(1.045)" }], { duration: 260 * d, easing: ease, fill: "forwards" }),
    ];
  },

  /** Veri renkleri her zaman yazılır; görünürlükleri .colorize sınıfına bağlı (CSS geçişli). */
  paint() {
    const { classify, classes } = state.scale;
    for (const [code, path] of this.paths) {
      const p = state.byCode.get(code);
      const i = p ? classify(p[state.metric]) : -1;
      path.style.setProperty("--f", i >= 0 ? classes[i].color : "");
      path.dataset.cls = i;
    }
  },

  setColorize(on) {
    this.svg.classList.toggle("colorize", on);
    if (state.hovered) this.setHover(state.hovered);
  },

  highlightClass(i) {
    if (i == null) return this.group.classList.remove("dimmed");
    for (const path of this.paths.values()) path.classList.toggle("in-class", +path.dataset.cls === i);
    this.group.classList.add("dimmed");
  },

  markSelected(code) {
    this.paths.get(this.selCode)?.classList.remove("is-sel");
    this.selCode = code;
    if (code) {
      this.selUse.setAttribute("href", `#${code}`);
      this.paths.get(code)?.classList.add("is-sel");
      this.selUse.style.setProperty("--sel", Profiles.accents(code).ui);
      this.svg.style.setProperty("--sel-tint", Profiles.color(code));
    } else {
      this.selUse.removeAttribute("href");
    }
    this.svg.classList.toggle("focus", !!code);
  },
};

/* --------------------------------------------------------------- Etiketler */
// İl adı + simge, ülke ve deniz adları. Konumlar her karede (yalnızca
// transform); hangi etiketin görüneceği ölçek değişince açgözlü yerleşimle
// hesaplanır: büyük iller önce, çakışan etiket gizlenir, küçük iller ancak
// yakınlaşınca görünür.
const Labels = {
  items: [], lastS: 0, byCode: new Map(),
  init() {
    this.layer = $("#map-labels");
    const html = [];
    for (const [code, path] of MapView.paths) {
      const p = state.byCode.get(code);
      if (!p) continue;
      html.push(`<div class="pl" data-code="${code}"><div class="pl-in">${Profiles.symbol(code, "pl-sym")}<span class="pl-name">${esc(p.province_name)}</span></div></div>`);
    }
    for (const a of document.querySelectorAll("#anchors .anchor")) {
      html.push(`<div class="ml ml-${a.dataset.kind}"><div class="pl-in"><span>${esc(a.dataset.label)}</span></div></div>`);
    }
    this.layer.innerHTML = html.join("");
    const anchors = [...document.querySelectorAll("#anchors .anchor")];
    let ai = 0;
    for (const el of this.layer.children) {
      if (el.dataset.code) {
        const path = MapView.paths.get(el.dataset.code);
        const it = { el, code: el.dataset.code, mx: +path.dataset.lx, my: +path.dataset.ly, area: +path.dataset.a, fixed: false, sym: el.querySelector(".pl-sym") };
        this.items.push(it);
        this.byCode.set(it.code, it);
      } else {
        const a = anchors[ai++];
        this.items.push({ el, mx: +a.getAttribute("cx"), my: +a.getAttribute("cy"), fixed: true, kind: a.dataset.kind });
      }
    }
    this.measure();
    document.fonts?.ready.then(() => { this.measure(); this.layout(); });
  },
  measure() {
    for (const it of this.items) { it.w = it.el.firstElementChild.offsetWidth; it.h = it.el.firstElementChild.offsetHeight; }
  },
  screen(it) {
    return { x: View.L + View.x + View.s * (View.ox + it.mx * View.k), y: View.T + View.y + View.s * (View.oy + it.my * View.k) };
  },
  position() {
    for (const it of this.items) {
      if (!it.on && !it.hot) continue;
      const { x, y } = this.screen(it);
      it.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
  },
  layout() {
    if (!View.W) return;
    this.lastS = View.s;
    const placed = [], pad = 3, cw = View.clip.clientWidth, ch = View.clip.clientHeight;
    const fits = (b) => !placed.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    const boxOf = (it, p) => ({ x0: p.x - it.w / 2 - pad, x1: p.x + it.w / 2 + pad, y0: p.y - it.h / 2 - pad, y1: p.y + it.h / 2 + pad });
    const sel = state.selected;
    const order = this.items.slice().sort((a, b) => (b.code === sel) - (a.code === sel) || b.fixed - a.fixed || (b.kind === "sea") - (a.kind === "sea") || (b.area || 0) - (a.area || 0));
    const minSide = mobile.matches ? 26 : 30;
    for (const it of order) {
      const p = this.screen(it), b = boxOf(it, p);
      const inView = p.x > -40 && p.x < cw + 40 && p.y > -20 && p.y < ch + 20;
      let on;
      if (it.fixed) on = inView && fits(b); // ülke/deniz adları da birbirini ezmesin (dar ekran)
      else if (it.code === sel) on = true;
      else on = inView && Math.sqrt(it.area) * View.k * View.s >= minSide && fits(b);
      if (on) placed.push(b);
      if (on !== it.on) { it.on = on; it.el.classList.toggle("on", on); }
      it.el.classList.toggle("sel", it.code === sel && !!sel);
    }
    this.position();
  },
  hot(code) {
    if (this.hotItem) { this.hotItem.hot = false; this.hotItem.el.classList.remove("hot"); }
    this.hotItem = code ? this.byCode.get(code) : null;
    const it = this.hotItem;
    if (!it) return;
    it.hot = true;
    it.el.classList.add("hot");
    const { x, y } = this.screen(it);
    it.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    if (motionOK && it.sym) {
      it.sym.animate([
        { transform: "translateY(0) scale(1)" },
        { transform: "translateY(-7px) scale(1.18)", offset: 0.38 },
        { transform: "translateY(0) scale(.96)", offset: 0.72 },
        { transform: "translateY(0) scale(1)" },
      ], { duration: 560, easing: "cubic-bezier(.3,.7,.4,1)" });
    }
  },
  focus(on) { this.layer.classList.toggle("focus", on); },
};

/* ------------------------------------------------------------------- İpucu */
const Tooltip = {
  on: false, raf: 0, x: -999, y: -999, tx: -999, ty: -999, cx: 0, cy: 0, w: 232, h: 170,
  init() {
    this.el = $("#tooltip");
    this.box = this.el.firstElementChild;
    this.r = Object.fromEntries(["plate", "region", "name", "value", "unit", "rank", "birth", "death", "birth-bar", "death-bar", "sym"]
      .map((k) => [k, $(`#tt-${k}`)]));
  },
  show(code) {
    const p = state.byCode.get(code);
    if (!p || mobile.matches) return;
    const m = METRICS[state.metric], r = this.r;
    r.plate.textContent = code.slice(3);
    r.region.textContent = `${p.region} Bölgesi`;
    r.sym.innerHTML = Profiles.symbol(code);
    r.name.textContent = p.province_name;
    r.value.textContent = fmt(state.metric, p[state.metric]);
    r.unit.textContent = `${m.unit === "‰" ? "binde" : m.unit}, ${m.label.toLocaleLowerCase("tr-TR")}`;
    const rr = regionRank(p, state.metric);
    r.rank.textContent = `81 il içinde ${p.ranks[state.metric]}., bölgesinde ${rr.rank}.`;
    const tot = (p.birth_rate || 0) + (p.death_rate || 0) || 1;
    r["birth-bar"].style.transform = `scaleX(${(p.birth_rate / tot).toFixed(3)})`;
    r["death-bar"].style.transform = `scaleX(${(p.death_rate / tot).toFixed(3)})`;
    r.birth.textContent = `‰ ${nf1.format(p.birth_rate)}`;
    r.death.textContent = `‰ ${nf1.format(p.death_rate)}`;
    const b = this.box.getBoundingClientRect(); // içerik değişince tek ölçüm
    this.w = b.width; this.h = b.height;
    this.on = true;
    this.el.classList.add("on");
    this.retarget();
    this.kick();
  },
  hide() { this.on = false; this.el.classList.remove("on"); },
  follow(x, y, snap = false) {
    this.cx = x; this.cy = y;
    this.retarget();
    if (snap || !this.on) { this.x = this.tx; this.y = this.ty; }
    this.kick();
  },
  retarget() {
    const g = 16;
    const fx = this.cx + g + this.w > innerWidth - 8, fy = this.cy + g + this.h > innerHeight - 8;
    this.tx = fx ? this.cx - g - this.w : this.cx + g;
    this.ty = fy ? this.cy - g - this.h : this.cy + g;
    const origin = `${fx ? "100%" : "0"} ${fy ? "100%" : "0"}`;
    if (origin !== this.origin) this.box.style.transformOrigin = this.origin = origin;
  },
  kick() { if (!this.raf) this.raf = requestAnimationFrame(this.tick); },
  tick: () => {
    const t = Tooltip, k = motionOK ? 0.35 : 1;
    t.x += (t.tx - t.x) * k; t.y += (t.ty - t.y) * k;
    t.el.style.transform = `translate3d(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px, 0)`;
    t.raf = Math.abs(t.tx - t.x) + Math.abs(t.ty - t.y) < 0.3 ? 0 : requestAnimationFrame(t.tick);
  },
};

function regionRank(p, metric) {
  const peers = state.provinces.filter((x) => x.region === p.region);
  return { rank: 1 + peers.filter((x) => (x[metric] ?? -Infinity) > (p[metric] ?? -Infinity)).length, of: peers.length };
}

/** Haritadan ya da listeden gelen hover tek yerden yönetilir. */
function hover(code, evt) {
  if (code === state.hovered) return;
  state.hovered = code;
  MapView.setHover(code);
  Labels.hot(code);
  Rank.markHot(code);
  if (!code) return Tooltip.hide();
  if (evt?.pointerType === "mouse") Tooltip.follow(evt.clientX, evt.clientY, !Tooltip.on);
  if (evt && evt.pointerType !== "touch") Tooltip.show(code);
}

/* ------------------------------------------------------------------ Lejant */
const Legend = {
  init() {
    this.el = $("#legend");
    this.list = $("#legend-scale");
    this.btn = $("#colorize");
    this.list.addEventListener("pointerover", (e) => { const li = e.target.closest("li"); if (li && state.colorize) MapView.highlightClass(+li.dataset.i); });
    this.list.addEventListener("pointerleave", () => MapView.highlightClass(null));
    this.btn.addEventListener("click", () => setColorize(!state.colorize));
  },
  render() {
    const { classes, metric } = state.scale, m = METRICS[metric];
    $("#legend-title").textContent = m.label;
    const y = yearOf(metric);
    $("#legend-unit").textContent = `${m.unit === "‰" ? "binde" : m.unit}${y ? `, ${y}` : ""}`;
    const max = Math.max(...classes.map((c) => c.count));
    this.list.innerHTML = classes.map((c, i) => `
      <li data-i="${i}" title="${c.count} il: ${fmt(metric, c.min, "short")} ile ${fmt(metric, c.max, "short")} arası">
        <div class="lg-hist"><i data-s="${(c.count / max).toFixed(3)}" style="transform:scaleY(0)"></i></div>
        <div class="lg-sw" style="background:${c.color}"></div>
        <span class="lg-label">${fmt(metric, c.min, "short")}</span>
      </li>`).join("");
    const sw = this.btn.querySelectorAll(".sw i");
    [0, Math.floor(classes.length / 2), classes.length - 1].forEach((ci, i) => sw[i] && (sw[i].style.background = classes[ci].color));
    if (state.colorize) raf2(() => this.grow());
  },
  grow() { this.list.querySelectorAll(".lg-hist i").forEach((el) => (el.style.transform = `scaleY(${el.dataset.s})`)); },
  sync() {
    this.el.classList.toggle("on", state.colorize);
    this.btn.setAttribute("aria-pressed", String(state.colorize));
    this.btn.querySelector(".lbl").textContent = state.colorize ? "Renkleri kapat" : "Verileri renklendir";
    if (state.colorize) raf2(() => this.grow());
  },
};

function setColorize(on) {
  state.colorize = on;
  MapView.setColorize(on);
  Legend.sync();
  try { localStorage.setItem("tna-colorize", on ? "1" : "0"); } catch { /* yok say */ }
}

/* ---------------------------------------------------------------- Sekmeler */
const Tabs = {
  init() {
    this.nav = $(".metrics");
    this.ink = $(".metrics-ink");
    this.nav.addEventListener("click", (e) => { const b = e.target.closest("button[data-metric]"); if (b) setMetric(b.dataset.metric); });
    this.nav.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = METRIC_KEYS.indexOf(state.metric);
      const next = METRIC_KEYS[(i + (e.key === "ArrowRight" ? 1 : METRIC_KEYS.length - 1)) % METRIC_KEYS.length];
      setMetric(next);
      this.nav.querySelector(`[data-metric="${next}"]`).focus();
    });
    addEventListener("resize", () => this.sync(false), { passive: true });
    document.fonts?.ready.then(() => this.sync(false));
  },
  sync(animate = true) {
    const btn = this.nav.querySelector(`[data-metric="${state.metric}"]`);
    this.nav.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
    if (!animate) this.ink.style.transition = "none";
    this.ink.style.transform = `translateX(${btn.offsetLeft}px) scaleX(${(btn.offsetWidth / 100).toFixed(4)})`;
    if (!animate) raf2(() => (this.ink.style.transition = ""));
    if (animate) btn.scrollIntoView({ block: "nearest", inline: "nearest", behavior: motionOK ? "smooth" : "auto" });
  },
};

/* ------------------------------------------------------------------ Başlık */
function renderLede(animate) {
  const m = METRICS[state.metric], k = state.metric;
  const sorted = state.provinces.filter((p) => p[k] != null).sort((a, b) => b[k] - a[k]);
  const stats = { hi: sorted[0], pos: sorted.filter((p) => p[k] > 0).length, neg: sorted.filter((p) => p[k] < 0).length };
  $("#headline").textContent = m.headline(sorted[0], sorted[sorted.length - 1]);
  $("#subline").textContent = m.sub(state.meta.national, stats);
  if (animate && motionOK) {
    const lede = $("#lede");
    lede.classList.remove("swap");
    void lede.offsetWidth; // animasyonu yeniden başlat (tek okuma, metrik değişiminde)
    lede.classList.add("swap");
  }
}

/* ---------------------------------------------------------------- Sıralama */
const ROW_H = 34;
const Rank = {
  rows: new Map(),
  init() {
    this.list = $("#rank-list");
    this.list.style.height = `${state.provinces.length * ROW_H}px`;
    this.list.innerHTML = state.provinces.map((p) => `
      <li data-code="${p.plate_code}">
        <a href="/il/${p.slug}">
          <span class="rk-n"></span><span class="rk-name">${Profiles.symbol(p.plate_code, "rk-sym")}${esc(p.province_name)}</span>
          <span class="rk-track"><i class="rk-zero"></i><i class="rk-bar"></i></span><span class="rk-v"></span>
        </a>
      </li>`).join("");
    for (const li of this.list.children) {
      this.rows.set(li.dataset.code, { li, n: $(".rk-n", li), bar: $(".rk-bar", li), zero: $(".rk-zero", li), v: $(".rk-v", li) });
    }
    this.list.addEventListener("pointerover", (e) => { const li = e.target.closest("li"); if (li) hover(li.dataset.code); });
    this.list.addEventListener("pointerleave", () => hover(null));
    // Gerçek bağlantı (arama motoru ve yeni sekme için); normal tıklama sayfa yüklemeden seçer
    this.list.addEventListener("click", (e) => {
      const li = e.target.closest("li");
      if (!li || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      select(li.dataset.code, { zoom: true });
    });
    $("#rank-order").addEventListener("click", () => {
      state.order = state.order === "desc" ? "asc" : "desc";
      this.update(true);
    });
  },
  /** Yeniden sıralama: satır başına doğrudan transform + metin yazılır.
      (Özel özellik (--y) yazmak Chrome'da ~15 kat daha yavaş ölçüldü.) */
  update(animate = true) {
    const k = state.metric, { classify, classes, min, max } = state.scale;
    $("#rank-title").textContent = METRICS[k].by;
    $("#rank-order").textContent = state.order === "desc" ? "En yüksek önce" : "En düşük önce";
    const dir = state.order === "desc" ? -1 : 1;
    const order = [...state.provinces].sort((a, b) => dir * ((a[k] ?? 0) - (b[k] ?? 0)));
    const lo = Math.min(0, min), range = Math.max(max, 0) - lo || 1;
    const zero = `${((-lo / range) * 100).toFixed(2)}%`;
    const short = k === "population" ? "short" : "full";
    order.forEach((p, i) => {
      const r = this.rows.get(p.plate_code);
      const v = p[k] ?? 0;
      r.y = i * ROW_H;
      r.li.style.transitionDelay = animate && motionOK ? `${Math.min(i, 30) * 6}ms` : "0ms";
      r.li.style.transform = `translateY(${r.y}px)`;
      r.n.textContent = p.ranks[k];
      r.v.textContent = fmt(k, v, short);
      r.bar.style.backgroundColor = classes[classify(v)]?.color ?? "";
      if (r.zeroAt !== zero) {
        r.bar.style.left = r.zero.style.left = r.zeroAt = zero;
        r.zero.style.opacity = lo < 0 ? "1" : "0";
      }
      r.s = (v / range).toFixed(4);
    });
    // İlk açılışta çubuklar sıfırdan büyür; sonrasında doğrudan geçiş yapar
    const write = () => { for (const r of this.rows.values()) r.bar.style.transform = `scaleX(${r.s})`; };
    if (this.drawn || !motionOK) write(); else raf2(write);
    this.drawn = true;
  },
  markHot(code) {
    this.hot?.li.classList.remove("hot");
    this.hot = code ? this.rows.get(code) : null;
    this.hot?.li.classList.add("hot");
  },
  markSelected(code) {
    for (const [c, r] of this.rows) r.li.classList.toggle("sel", c === code);
  },
  reveal(code) {
    const r = this.rows.get(code);
    if (!r) return;
    const y = r.y || 0;
    const sc = $("#rank-scroll");
    if (y < sc.scrollTop || y > sc.scrollTop + sc.clientHeight - ROW_H) sc.scrollTo({ top: y - sc.clientHeight / 3, behavior: motionOK ? "smooth" : "auto" });
  },
};

/* ------------------------------------------------------------------- Detay */
const DETAIL_METRICS = ["population", "population_density", "birth_rate", "death_rate", "natural_growth_rate", "net_migration_rate", "median_age"];
const NO_DATA = `<span class="nd">veri yok</span>`;
const TABS = ["general", "culture", "places", "demo"];

const Detail = {
  tab: "general", counterRaf: 0,
  init() {
    this.panel = $("#panel");
    this.view = $("#view-detail");
    this.hero = $("#dt-hero");
    this.body = $("#dtp");
    this.tabs = $("#dt-tabs");
    this.ink = $(".dt-tabs-ink");
    try { const t = localStorage.getItem("tna-tab"); if (TABS.includes(t)) this.tab = t; } catch { /* yok say */ }
    this.tabs.addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) this.show(b.dataset.tab, true); });
    this.tabs.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = TABS.indexOf(this.tab);
      const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      this.show(next, true);
      this.tabs.querySelector(`[data-tab="${next}"]`).focus();
    });
    $("#dt-back").addEventListener("click", () => deselect());
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.selected && !e.target.closest?.("input")) deselect(); });
    this.initSheet();
    addEventListener("resize", () => this.syncInk(false), { passive: true });
  },

  /** Mobil alt sayfa: tutamaktan aşağı çekince kapanır. */
  initSheet() {
    const h = $("#sheet-handle");
    let y0 = null, dy = 0;
    const end = () => {
      if (y0 == null) return;
      this.view.style.transition = this.view.style.transform = "";
      if (dy > 90) deselect();
      y0 = null; dy = 0;
    };
    h.addEventListener("pointerdown", (e) => { y0 = e.clientY; dy = 0; h.setPointerCapture(e.pointerId); this.view.style.transition = "none"; });
    h.addEventListener("pointermove", (e) => {
      if (y0 == null) return;
      dy = Math.max(0, e.clientY - y0);
      this.view.style.transform = `translateY(${dy}px)`;
    });
    h.addEventListener("pointerup", end);
    h.addEventListener("pointercancel", end);
  },

  /** Vurgu rengi temaya göre (tema değişince de çağrılır). */
  setAccent(code) {
    const a = Profiles.accents(code);
    const s = this.view.style;
    s.setProperty("--acc", a.text);
    s.setProperty("--acc-ui", a.ui);
    s.setProperty("--acc-raw", a.base);
  },

  open(code) {
    const p = state.byCode.get(code);
    if (!p) return;
    const pr = Profiles.get(code);
    this.code = code;
    this.setAccent(code);
    $("#dt-plate").textContent = code.slice(3);
    $("#dt-region").textContent = `${p.region} Bölgesi`;
    $("#dt-name").textContent = p.province_name;
    $("#dt-sym").innerHTML = Profiles.symbol(code);
    $("#dt-tag").textContent = pr.symbol_label || "";
    $("#dt-src").textContent = "Nüfus: TÜİK ADNKS · Yüzölçümü: HGM · Rakım: Vikipedi (kaynaklar çelişirse boş) · Kültür bilgileri elle derlendi; emin olunmayan alanlar boş bırakıldı.";
    // Renk dalgası ve satır animasyonları her ilde yeniden başlar
    this.hero.classList.remove("wave");
    void this.hero.offsetWidth;
    this.hero.classList.add("wave");
    this.render(true);
    this.panel.classList.add("detail");
    this.view.setAttribute("aria-hidden", "false");
    $("#view-rank").setAttribute("aria-hidden", "true");
    this.view.scrollTop = 0;
    raf2(() => this.syncInk(false));
  },

  close() {
    this.code = null;
    this.panel.classList.remove("detail");
    this.view.setAttribute("aria-hidden", "true");
    $("#view-rank").setAttribute("aria-hidden", "false");
  },

  show(tab, animate) {
    if (tab === this.tab && !animate) return;
    const dir = TABS.indexOf(tab) >= TABS.indexOf(this.tab) ? 1 : -1;
    this.tab = tab;
    try { localStorage.setItem("tna-tab", tab); } catch { /* yok say */ }
    this.render(false, dir);
    this.syncInk(true);
  },

  syncInk(animate) {
    const btn = this.tabs.querySelector(`[data-tab="${this.tab}"]`);
    this.tabs.querySelectorAll("[role=tab]").forEach((b) => {
      const on = b === btn;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    this.body.setAttribute("aria-labelledby", btn.id);
    if (!btn.offsetWidth) return;
    if (!animate) this.ink.style.transition = "none";
    this.ink.style.transform = `translateX(${btn.offsetLeft}px) scaleX(${(btn.offsetWidth / 100).toFixed(4)})`;
    if (!animate) raf2(() => (this.ink.style.transition = ""));
  },

  render(first, dir = 1) {
    const code = this.code;
    if (!code) return;
    const html = { general: () => this.general(code), culture: () => this.culture(code), places: () => this.places(code), demo: () => this.demo(code) }[this.tab]();
    this.body.innerHTML = html;
    this.body.style.setProperty("--dir", dir);
    this.body.classList.remove("in");
    void this.body.offsetWidth;
    this.body.classList.add("in");
    if (first) this.body.classList.add("first"); else this.body.classList.remove("first");
    this.runCounters();
    raf2(() => this.body.querySelectorAll(".cmp-bar").forEach((el) => (el.style.transform = `scaleX(${el.dataset.v})`)));
  },

  row(i, label, value) {
    return `<tr style="--i:${i}"><th scope="row">${label}</th><td>${value ?? NO_DATA}</td></tr>`;
  },

  /** Türkiye il ortalamasına göre gösterge: ortalama çizgisi %33'te, 3 katı ve üstü dolu. */
  compare(v, avg) {
    const r = v / avg;
    const txt = r >= 1.05 ? `il ortalamasının ${nf1.format(r)} katı` : r <= 0.95 ? `il ortalamasının %${nf.format(Math.round(r * 100))} kadarı` : "il ortalaması kadar";
    return `<div class="cmp" title="Türkiye il ortalaması: ${nf.format(Math.round(avg))}">
      <div class="cmp-track"><i class="cmp-bar" data-v="${Math.min(1, r / 3).toFixed(3)}"></i><i class="cmp-avg"></i></div>
      <span class="cmp-txt">${txt}</span></div>`;
  },

  count(to, kind = "int", suffix = "") {
    return `<b class="cnt" data-to="${to}" data-kind="${kind}">${kind === "dec" ? nf1.format(0) : "0"}</b>${suffix}`;
  },

  general(code) {
    const p = state.byCode.get(code), pr = Profiles.get(code), nat = state.meta.national;
    const n = state.provinces.length || 81;
    const avgPop = nat.population / n, avgArea = (nat.area_km2 || state.provinces.reduce((s, x) => s + (x.area_km2 || 0), 0)) / n;
    const popY = yearOf("population");
    let i = 0;
    const rows = [
      this.row(i++, "Bölge", `${esc(p.region)} Bölgesi`),
      this.row(i++, `Nüfus${popY ? ` <small>${popY}</small>` : ""}`, `${this.count(p.population)} <small>kişi</small>${this.compare(p.population, avgPop)}`),
      this.row(i++, "Yüzölçümü", p.area_km2 ? `${this.count(p.area_km2)} <small>km²</small>${this.compare(p.area_km2, avgArea)}` : null),
      this.row(i++, "Nüfus yoğunluğu", p.population_density != null ? `${this.count(Math.round(p.population_density))} <small>kişi/km²</small>` : null),
      this.row(i++, "Rakım <small>il merkezi</small>", pr.elevation_m != null ? `${this.count(pr.elevation_m)} <small>m</small>` : null),
      this.row(i++, "Telefon alan kodu", pr.area_code ? `<span class="mono">0${esc(pr.area_code)}</span>` : null),
      this.row(i++, "İlçe sayısı", pr.district_count != null ? this.count(pr.district_count) : null),
      this.row(i++, "Plaka kodu", `<span class="plate acc">${code.slice(3)}</span>`),
    ];
    return `<table class="kv"><caption class="sr">Genel bilgiler</caption><tbody>${rows.join("")}</tbody></table>
      <section class="dt-note" style="--i:${i}"><h3>Kısa tarihçe</h3><p>${pr.history ? esc(pr.history) : NO_DATA}</p></section>`;
  },

  list(items) {
    return items?.length ? `<ul class="chips">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : null;
  },

  culture(code) {
    const pr = Profiles.get(code);
    let i = 0;
    const rows = [
      this.row(i++, "Simge", pr.symbol_label ? `<span class="sym-cell">${Profiles.symbol(code)}${esc(pr.symbol_label)}</span>` : null),
      this.row(i++, "Meşhur yemekler", this.list(pr.foods)),
      this.row(i++, "Meşhur ürünler", this.list(pr.products)),
      this.row(i++, "Festival ve etkinlikler", this.list(pr.festivals)),
      this.row(i++, "İlin rengi", pr.color ? `<span class="swatch-cell"><i class="swatch"></i><span><span class="mono">${esc(pr.color.toUpperCase())}</span><br>${esc(pr.color_reason || "")}</span></span>` : null),
    ];
    return `<table class="kv"><caption class="sr">Kültür ve lezzet</caption><tbody>${rows.join("")}</tbody></table>`;
  },

  places(code) {
    const pr = Profiles.get(code);
    if (!pr.sights?.length) return `<p class="empty">${NO_DATA}</p>`;
    return `<ol class="places">${pr.sights.map((s, i) => `<li style="--i:${i}"><span class="pn">${i + 1}</span><span>${esc(s)}</span></li>`).join("")}</ol>`;
  },

  demo(code) {
    const p = state.byCode.get(code), nat = state.meta.national;
    const rows = DETAIL_METRICS.map((k, i) => {
      const m = METRICS[k], y = yearOf(k);
      const natV = k === "population" ? nat.avg_province_population : nat[k];
      const unit = m.unit === "‰" ? "‰" : m.unit;
      const v = p[k];
      const val = v == null ? NO_DATA : k === "natural_growth_rate" || k === "net_migration_rate"
        ? `<b>${fmt(k, v)}</b>` : this.count(v, k === "population" || k === "population_density" ? "int" : "dec");
      return `<tr style="--i:${i}"><th scope="row">${m.label}${y ? ` <small>${y}</small>` : ""}</th>
        <td class="num">${val} <small>${unit}</small></td><td class="num">${fmt(k, natV)}</td><td class="num">${p.ranks[k] ?? "—"}.</td></tr>`;
    });
    return `<table class="grid"><caption class="sr">Demografi</caption>
      <thead><tr><th scope="col">Gösterge</th><th scope="col" class="num">Bu il</th><th scope="col" class="num">Türkiye</th><th scope="col" class="num">Sıra</th></tr></thead>
      <tbody>${rows.join("")}</tbody></table>
      <p class="dt-foot">Türkiye sütununda nüfus için il ortalaması verilir. Sıra 81 il içindedir (en yüksek 1.).</p>`;
  },

  /** Sayaçlar: tek rAF döngüsü, easeOutExpo. Hareket azaltılmışsa doğrudan değer. */
  runCounters() {
    cancelAnimationFrame(this.counterRaf);
    const els = [...this.body.querySelectorAll(".cnt")].map((el) => ({ el, to: +el.dataset.to, dec: el.dataset.kind === "dec" }));
    const put = (e) => { for (const c of els) c.el.textContent = c.dec ? nf1.format(c.to * e) : nf.format(Math.round(c.to * e)); };
    if (!motionOK) return put(1);
    const t0 = performance.now(), dur = 900;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur), e = t === 1 ? 1 : 1 - 2 ** (-10 * t);
      put(e);
      if (t < 1) this.counterRaf = requestAnimationFrame(step);
    };
    this.counterRaf = requestAnimationFrame(step);
  },
};

/** Mobilde alt sayfa haritanın altını örter: uçuşta görünür alan küçülür. */
function sheetOverlap() {
  if (!mobile.matches) return 0;
  const clip = View.clip.getBoundingClientRect();
  const sheetH = Math.min(innerHeight * 0.58, 620);
  return Math.max(0, clip.bottom - (innerHeight - sheetH));
}

function select(code, { zoom = false, push = true } = {}) {
  if (!state.byCode.has(code)) return;
  if (!state.selected) View.saved = View.anim?.to || View.cur(); // kapatınca dönülecek görünüm
  state.selected = code;
  MapView.markSelected(code);
  Labels.focus(true);
  Rank.markSelected(code);
  Table.markSelected(code);
  Detail.open(code);
  SelPill.show(code);
  View.sheetOverlap = sheetOverlap();
  if (!state.tabular) View.measure(); // mobilde başlık gizlenince harita alanı büyür
  if (zoom && !state.tabular) View.flyTo(code);
  else Labels.layout();
  writeUrl(push);
}

function deselect({ push = true } = {}) {
  if (!state.selected) return;
  // Klavye odağı kapanan panelde kalmasın: sıralamaya taşı
  if (Detail.view.contains(document.activeElement)) $("#rank-order").focus({ preventScroll: true });
  state.selected = null;
  MapView.markSelected(null);
  Labels.focus(false);
  Rank.markSelected(null);
  Table.markSelected(null);
  Detail.close();
  SelPill.hide();
  View.sheetOverlap = 0;
  const back = View.saved ? View.clampView(View.saved) : View.clampView({ s: 1, x: 0, y: 0 });
  View.saved = null;
  View.tween(back, 750);
  hover(null);
  renderLede(true); // il sayfasından gelindiyse sunucudaki ile özel başlık genele döner
  writeUrl(push);
}

/* ---------------------------------------------------------- Seçimi kapatma */
// Yollar: paneldeki çarpı, haritadaki "il ✕" hapı, haritada il dışında boş bir yere basmak, Esc.
const SelPill = {
  init() {
    this.el = $("#sel-pill");
    this.area = $(".map-area");
    this.el.addEventListener("click", () => deselect());
    $("#dt-close").addEventListener("click", () => deselect());
    // Haritanın boş alanı (deniz, komşu ülke, kenar boşluğu) seçimi kapatır.
    // Denetimler, bağlantılar, lejant ve tablo görünümü hariç; sürükleme sonrası da hariç.
    this.area.addEventListener("click", (e) => {
      if (!state.selected || state.tabular || View.justDragged()) return;
      if (e.target.closest(".province, button, a, input, .legend, .table-view, .view-switch")) return;
      deselect();
    });
  },
  show(code) {
    const p = state.byCode.get(code);
    $("#sel-plate").textContent = code.slice(3);
    $("#sel-name").textContent = p.province_name;
    this.el.setAttribute("aria-label", `${p.province_name} seçimini kapat`);
    this.el.style.setProperty("--acc", Profiles.accents(code).text);
    this.el.tabIndex = 0;
    this.el.classList.add("show");
    this.area.classList.add("has-sel");
  },
  hide() {
    this.el.classList.remove("show");
    this.el.tabIndex = -1;
    this.area.classList.remove("has-sel");
  },
};

/* ------------------------------------------------------------------- Tablo */
const Table = {
  init() {
    this.view = $("#table-view");
    this.table = $("#data-table");
    this.body = this.table.tBodies[0];
    this.rows = new Map([...this.body.rows].map((tr) => [tr.dataset.code, tr]));
    this.sortKey = "plate_code"; this.sortDir = 1;
    $("#tab-map").addEventListener("click", () => this.show(false));
    $("#tab-table").addEventListener("click", () => this.show(true));
    this.table.tHead.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-k]");
      if (!th) return;
      const k = th.dataset.k;
      this.sortDir = this.sortKey === k ? -this.sortDir : (["plate_code", "province_name", "region"].includes(k) ? 1 : -1);
      this.sortKey = k;
      this.sort();
    });
    this.body.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-code]");
      if (!tr || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      select(tr.dataset.code);
    });
    this.body.addEventListener("pointerover", (e) => { const tr = e.target.closest("tr[data-code]"); if (tr) Rank.markHot(tr.dataset.code); });
  },
  show(on) {
    state.tabular = on;
    $(".atlas").classList.toggle("tabular", on);
    this.view.hidden = !on;
    $("#tab-map").setAttribute("aria-selected", String(!on));
    $("#tab-table").setAttribute("aria-selected", String(on));
    if (on) { this.highlight(); this.view.focus({ preventScroll: true }); }
    else {
      View.measure();
      if (state.selected) View.flyTo(state.selected, true); else View.apply(View.clampView({ s: 1, x: 0, y: 0 }));
      Labels.measure();
      Labels.layout();
    }
  },
  /** DOM düğümleri yeniden oluşturulmaz; yalnızca sırası değişir. */
  sort() {
    const k = this.sortKey, dir = this.sortDir;
    const cmp = (a, b) => {
      const pa = state.byCode.get(a), pb = state.byCode.get(b);
      const va = pa[k], vb = pb[k];
      return dir * (typeof va === "number" ? va - vb : String(va).localeCompare(String(vb), "tr"));
    };
    const frag = document.createDocumentFragment();
    [...this.rows.keys()].sort(cmp).forEach((c) => frag.append(this.rows.get(c)));
    this.body.append(frag);
    for (const th of this.table.tHead.rows[0].cells) {
      if (th.dataset.k === k) th.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    }
  },
  /** Seçili metriğin sütununu vurgula. */
  highlight() {
    if (this.view.hidden) return;
    const idx = [...this.table.tHead.rows[0].cells].findIndex((th) => th.dataset.k === state.metric);
    for (const row of this.table.rows) [...row.cells].forEach((c, i) => c.classList.toggle("hl", i === idx));
  },
  markSelected(code) {
    for (const [c, tr] of this.rows) tr.classList.toggle("sel", c === code);
  },
};

/* ------------------------------------------------------------------- Arama */
const Search = {
  items: [], active: -1,
  init() {
    this.input = $("#search-input");
    this.list = $("#search-list");
    this.box = $(".search");
    this.input.addEventListener("input", () => this.update());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!this.items.length) return;
        this.active = (this.active + (e.key === "ArrowDown" ? 1 : -1) + this.items.length) % this.items.length;
        [...this.list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === this.active)));
        this.input.setAttribute("aria-activedescendant", `sl-${this.active}`);
      } else if (e.key === "Enter") {
        const it = this.items[Math.max(0, this.active)];
        if (it) this.choose(it.plate_code);
      } else if (e.key === "Escape") {
        this.close(); this.input.blur();
      }
    });
    this.list.addEventListener("pointerdown", (e) => {
      const li = e.target.closest("li[data-code]");
      if (li) { e.preventDefault(); this.choose(li.dataset.code); }
    });
    this.input.addEventListener("blur", () => setTimeout(() => this.close(), 100));
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !e.target.closest?.("input,textarea")) { e.preventDefault(); this.input.focus(); }
    });
  },
  update() {
    const q = trFold(this.input.value.trim());
    if (!q) return this.close();
    const starts = [], has = [];
    for (const p of state.provinces) {
      const n = trFold(p.province_name);
      if (n.startsWith(q) || p.plate_code.slice(3) === q.padStart(2, "0")) starts.push(p);
      else if (n.includes(q)) has.push(p);
    }
    this.items = [...starts, ...has].slice(0, 8);
    this.active = this.items.length ? 0 : -1;
    this.list.innerHTML = this.items.length
      ? this.items.map((p, i) => {
          const n = p.province_name, at = trFold(n).indexOf(q);
          const label = at >= 0 ? `${esc(n.slice(0, at))}<mark>${esc(n.slice(at, at + q.length))}</mark>${esc(n.slice(at + q.length))}` : esc(n);
          return `<li role="option" id="sl-${i}" data-code="${p.plate_code}" aria-selected="${i === 0}"><span class="plate">${p.plate_code.slice(3)}</span>${Profiles.symbol(p.plate_code, "sl-sym")}<span>${label}</span><span class="sl-region">${esc(p.region)}</span></li>`;
        }).join("")
      : `<li class="sl-empty">Bu adla bir il yok</li>`;
    this.list.hidden = false;
    this.box.setAttribute("aria-expanded", "true");
  },
  choose(code) {
    this.close();
    this.input.value = "";
    this.input.blur();
    select(code, { zoom: true });
    Rank.reveal(code);
  },
  close() { this.list.hidden = true; this.items = []; this.box.setAttribute("aria-expanded", "false"); },
};

/* ------------------------------------------------------------------- Durum */
const Status = {
  text: {
    live: "Resmi veri, güncel", cached: "Resmi veri", fallback: "Yerel veri seti",
    error: "Sunucuya ulaşılamıyor", offline: "Çevrimdışı",
  },
  render(mode, syncedAt) {
    const el = $("#status");
    el.dataset.mode = mode;
    const when = syncedAt ? new Date(syncedAt).toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" }) : null;
    $("span", el).textContent = this.text[mode] || mode;
    el.title = when ? `Kaynaklarla son eşitleme: ${when}` : "Henüz resmi kaynaklarla eşitlenmedi";
  },
};

/** Kaynak notu metrik bazında üretilir: aynı kaynağı paylaşan metrikler tek cümlede. */
const SOURCE_LABELS = {
  population: "nüfus", area_km2: "yüzölçümü", birth_rate: "doğum", death_rate: "ölüm",
  net_migration_rate: "göç", median_age: "ortanca yaş",
};
function renderSources() {
  const metrics = state.meta.metrics || {};
  const groups = new Map();
  for (const [k, label] of Object.entries(SOURCE_LABELS)) {
    const info = metrics[k];
    if (!info) continue;
    // kaynak + yıl aynıysa tek grupta: "Doğum, ölüm ve göç 2024: Eurostat ..."
    const key = `${info.official ? info.source : "Yaklaşık tahmin"}|${info.year ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(label);
  }
  const lines = [...groups].map(([key, items]) => {
    const [src, year] = key.split("|");
    const list = items.length > 1 ? `${items.slice(0, -1).join(", ")} ve ${items.at(-1)}` : items[0];
    return `${list[0].toLocaleUpperCase("tr-TR")}${list.slice(1)}${year ? ` ${year}` : ""}: ${src}.`;
  });
  $("#sources").textContent = lines.join(" ");
}

const yearOf = (k) => state.meta?.metrics?.[k]?.year;

/* ----------------------------------------------------------------- Durum/URL */
// Adres: /il/istanbul?g=net_migration_rate  (il sayfaları sunucuda da üretilir)
const SITE_TITLE = "Türkiye Nüfus Atlası";
function writeUrl(push = false) {
  const p = state.selected && state.byCode.get(state.selected);
  const q = state.metric !== "population" ? `?g=${state.metric}` : "";
  const url = (p ? `/il/${p.slug}` : "/") + q;
  document.title = p ? `${p.province_name} nüfusu ve demografisi | ${SITE_TITLE}` : `${SITE_TITLE}: 81 ilin nüfus, doğum, ölüm ve göç haritası`;
  if (url === location.pathname + location.search) return;
  try { history[push ? "pushState" : "replaceState"]({ code: state.selected, metric: state.metric }, "", url); } catch { /* yok say */ }
}
function readUrl() {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.slice(1)); // eski bağlantılar: #g=...&il=34
  const metric = [q.get("g"), h.get("g")].find((m) => METRICS[m]) || null;
  const slug = decodeURIComponent(location.pathname.match(/^\/il\/([^/]+)/)?.[1] || "");
  const fromSlug = slug && state.provinces.find((p) => p.slug === slug)?.plate_code;
  const il = h.get("il");
  return { metric, code: fromSlug || document.body.dataset.province || (il ? `TR-${il.padStart(2, "0")}` : null) };
}

function setMetric(metric, animate = true) {
  if (!METRICS[metric] || (metric === state.metric && state.scale && animate)) return;
  state.metric = metric;
  restyle(animate);
  renderLede(animate);
  if (state.hovered) Tooltip.show(state.hovered);
  writeUrl(false);
}

/** Renk ölçeğine bağlı her şeyi yeniden çiz (metrik ya da tema değişimi). */
function restyle(animate) {
  state.scale = buildScale(state.metric);
  Tabs.sync(animate);
  MapView.paint();
  Legend.render();
  Rank.update(animate);
  Table.highlight();
}

function ingest(payload) {
  state.provinces = payload.data;
  state.byCode = new Map(payload.data.map((p) => [p.plate_code, p]));
  state.meta = payload.meta;
  state.lastUpdated = payload.meta.last_updated;
  Status.render(payload.meta.mode, payload.meta.synced_at);
  renderSources();
}

async function poll() {
  if (!navigator.onLine) return Status.render("offline", state.meta?.synced_at);
  try {
    const s = await Api.status();
    Status.render(s.mode, s.synced_at);
    if (s.last_updated !== state.lastUpdated) {
      // CLI --sync sonrası: sayfa yenilenmeden yeni veri uygulanır
      ingest(await Api.provinces());
      restyle(true);
      renderLede(true);
      if (state.selected) Detail.open(state.selected);
    }
  } catch {
    Status.render("error");
  }
}

/* -------------------------------------------------------------------- Tema */
// Varsayılan açık tema. İlk açılışta cihaz ayarı; kullanıcı seçtiyse o hatırlanır.
const THEME_COLOR = { light: "#FFFFFF", dark: "#000000" };
function applyTheme(next, animate = true) {
  const root = document.documentElement;
  if (animate && motionOK) {
    root.classList.add("theme-anim");
    clearTimeout(applyTheme.t);
    applyTheme.t = setTimeout(() => root.classList.remove("theme-anim"), 650);
  }
  root.dataset.theme = next;
  $('meta[name="theme-color"]').content = THEME_COLOR[next];
  $("#theme-toggle").setAttribute("aria-label", next === "dark" ? "Açık temaya geç" : "Karanlık temaya geç");
  restyle(false);
  if (state.selected) {
    Detail.setAccent(state.selected);
    MapView.markSelected(state.selected);
    SelPill.show(state.selected);
  }
  if (state.hovered) MapView.setHover(state.hovered);
}

function initTheme() {
  const btn = $("#theme-toggle");
  $('meta[name="theme-color"]').content = THEME_COLOR[state.theme()];
  btn.setAttribute("aria-label", state.theme() === "dark" ? "Açık temaya geç" : "Karanlık temaya geç");
  btn.addEventListener("click", () => {
    const next = state.theme() === "dark" ? "light" : "dark";
    try { localStorage.setItem("tna-theme", next); } catch { /* yok say */ }
    applyTheme(next);
  });
  // Kullanıcı seçim yapmadıysa cihazın tema değişimini izle
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", (e) => {
    let stored = null;
    try { stored = localStorage.getItem("tna-theme"); } catch { /* yok say */ }
    if (!stored) applyTheme(e.matches ? "dark" : "light");
  });
}

/** İlk veri HTML'e gömülü gelir (ek istek yok, çevrimdışı da çalışır); yoksa API'den. */
async function loadInitial() {
  const el = document.getElementById("initial-data");
  if (el?.textContent.trim()) {
    try { return JSON.parse(el.textContent); } catch { /* API'ye düş */ }
  }
  return Api.provinces();
}

async function main() {
  Tooltip.init();
  Profiles.init();
  try {
    ingest(await loadInitial());
  } catch (err) {
    console.error(err);
    Status.render("error");
    $("#headline").textContent = "Veriler yüklenemedi.";
    $("#subline").textContent = "Sunucunun çalıştığını kontrol edip sayfayı yenileyin.";
    return;
  }
  initTheme();
  MapView.init();
  View.init();
  Labels.init();
  Legend.init();
  Tabs.init();
  Rank.init();
  Detail.init();
  Search.init();
  Table.init();
  SelPill.init();

  const h = readUrl();
  state.metric = h.metric || "population";
  let colorize = !!h.metric;
  try { colorize = colorize || localStorage.getItem("tna-colorize") === "1"; } catch { /* yok say */ }
  restyle(false);
  setColorize(colorize);
  View.apply(View.clampView({ s: 1, x: 0, y: 0 }));
  Labels.layout();
  // İl sayfasında başlık sunucudan gelir (o ile özel); metrik değişince genel başlığa geçilir
  if (document.body.dataset.page !== "province" || h.metric) renderLede(false);
  // Tek orkestrasyon anı: iller sırayla belirir, ardından etiketler, çubuklar büyür
  MapView.intro();
  document.body.classList.add("ready");
  setTimeout(() => $("#map-labels").classList.add("settled"), motionOK ? 1500 : 0);
  if (h.code && state.byCode.has(h.code)) {
    setTimeout(() => { select(h.code, { zoom: true, push: false }); Rank.reveal(h.code); }, motionOK ? 900 : 0);
  } else {
    writeUrl(false); // eski #... bağlantılarını temiz adrese çevir
  }

  // Tarayıcının geri/ileri tuşları
  addEventListener("popstate", () => {
    const { metric, code } = readUrl();
    setMetric(metric || "population");
    if (code && state.byCode.has(code)) { select(code, { zoom: true, push: false }); Rank.reveal(code); }
    else if (state.selected) deselect({ push: false });
  });

  setInterval(poll, 5 * 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && poll());
  addEventListener("online", poll);
  addEventListener("offline", () => Status.render("offline", state.meta?.synced_at));

  // PWA: çevrimdışı çalışma ve ana ekrana ekleme
  const secure = location.protocol === "https:" || location.hostname === "localhost";
  if ("serviceWorker" in navigator && secure) {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => { /* PWA isteğe bağlı */ });
  }
}

main();
