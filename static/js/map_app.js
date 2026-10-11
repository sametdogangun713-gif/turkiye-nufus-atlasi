/* =========================================================================
   Türkiye Nüfus Atlası — istemci
   Bölümler: Biçim · Metrikler · Ölçek · Harita · İpucu · Lejant · Sekmeler ·
             Başlık · Sıralama · Detay · Arama · Durum · Başlatma
   Performans ilkeleri:
     - Hareket = transform/opacity. Yakınlaştırma HTML katmanında (GPU).
     - Metrik geçişi: eski haritanın HTML kopyası söner (kompozitör), SVG
       her karede yeniden boyanmaz.
     - Sıralama listesi mutlak konumlu; yeniden sıralama = translateY, DOM
       sırası ve düzen hesabı değişmez.
     - mousemove yalnızca hedefi kaydeder; yazımlar tek rAF döngüsünde.
   ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);
const SVG_NS = "http://www.w3.org/2000/svg";
const motionOK = !matchMedia("(prefers-reduced-motion: reduce)").matches;
const mobile = matchMedia("(max-width: 860px)");
const raf2 = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

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
    neutral: "#46516a",
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
  hovered: null, selected: null,
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

/* ------------------------------------------------------------------ Harita */
const MapView = {
  paths: new Map(), zoomed: false, anims: [],

  init() {
    this.svg = $("#turkey-map");
    this.stage = $("#map-stage");
    this.group = $("#provinces");
    this.vb = this.svg.viewBox.baseVal;
    const viewport = $("#map-viewport");

    viewport.insertAdjacentHTML("beforeend", `
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
    g.addEventListener("pointerover", (e) => { const c = codeOf(e); if (c) hover(c, e); });
    g.addEventListener("pointerleave", () => hover(null));
    g.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") Tooltip.follow(e.clientX, e.clientY); }, { passive: true });
    g.addEventListener("click", (e) => { const c = codeOf(e); if (c) select(c, { zoom: true }); });
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
    $("#zoom-reset").addEventListener("click", () => this.resetZoom());
    addEventListener("resize", () => { if (this.zoomed && state.selected) this.focus(state.selected, true); }, { passive: true });
  },

  /** Hover: gölge + üst kopya, yalnızca transform/opacity (WAAPI). */
  setHover(code) {
    this.anims.forEach((a) => a.cancel());
    const d = motionOK ? 1 : 0;
    if (!code) {
      this.anims = [
        this.top.animate([{ opacity: 1, transform: "scale(1.025)" }, { opacity: 0, transform: "scale(1)" }], { duration: 140 * d, easing: "ease-out", fill: "forwards" }),
        this.shadow.animate([{ opacity: 0.22, transform: "translate(0, 2.5px) scale(1.025)" }, { opacity: 0, transform: "none" }], { duration: 140 * d, easing: "ease-out", fill: "forwards" }),
      ];
      return;
    }
    this.top.setAttribute("href", `#${code}`);
    this.shadow.setAttribute("href", `#${code}`);
    const ease = "cubic-bezier(0.34, 1.4, 0.64, 1)";
    this.anims = [
      this.top.animate([{ opacity: 0.6, transform: "scale(1)" }, { opacity: 1, transform: "scale(1.025)" }], { duration: 240 * d, easing: ease, fill: "forwards" }),
      this.shadow.animate([{ opacity: 0, transform: "none" }, { opacity: 0.22, transform: "translate(0, 2.5px) scale(1.025)" }], { duration: 240 * d, easing: ease, fill: "forwards" }),
    ];
  },

  /** Geçiş katmanı: haritanın etkileşimsiz kopyası, bir kez oluşturulur.
      Her metrik değişiminde klonlamak SVG geometrisini yeniden hesaplatırdı. */
  buildFadeLayer() {
    const copy = this.svg.cloneNode(true);
    copy.removeAttribute("id");
    copy.classList.add("fade-copy");
    copy.setAttribute("aria-hidden", "true");
    copy.querySelectorAll("use").forEach((el) => el.remove());
    this.fadePaths = [];
    for (const el of copy.querySelectorAll("[id]")) {
      if (el.classList.contains("province")) this.fadePaths.push([el, this.paths.get(el.id)]);
      el.removeAttribute("id");
      el.removeAttribute("tabindex");
      el.removeAttribute("role");
      el.removeAttribute("aria-label");
    }
    copy.style.opacity = "0";
    this.fade = copy;
    this.stage.append(copy);
  },

  /** Renkleri uygula. Eski renkler HTML kopya katmanında söner (yalnızca opacity). */
  paint(animate = true) {
    if (animate && motionOK && this.painted) {
      if (!this.fade) this.buildFadeLayer();
      const f = this.fade;
      for (const [copyPath, src] of this.fadePaths) copyPath.style.setProperty("--f", src.style.getPropertyValue("--f"));
      f.style.transition = "none";
      f.style.opacity = "1";
      raf2(() => { f.style.transition = ""; f.style.opacity = "0"; });
    }
    const { classify, classes } = state.scale;
    for (const [code, path] of this.paths) {
      const p = state.byCode.get(code);
      const i = p ? classify(p[state.metric]) : -1;
      path.style.setProperty("--f", i >= 0 ? classes[i].color : "");
      path.dataset.cls = i;
    }
    this.painted = true;
  },

  highlightClass(i) {
    if (i == null) return this.group.classList.remove("dimmed");
    for (const path of this.paths.values()) path.classList.toggle("in-class", +path.dataset.cls === i);
    this.group.classList.add("dimmed");
  },

  markSelected(code) {
    if (code) this.selUse.setAttribute("href", `#${code}`);
    else this.selUse.removeAttribute("href");
  },

  /** İlin sınır kutusuna odaklan. Dönüşüm HTML katmanında: GPU ölçekler. */
  focus(code, instant = false) {
    const path = this.paths.get(code);
    if (!path) return;
    const bb = path.getBBox();
    const W = this.stage.offsetWidth, H = this.stage.offsetHeight; // dönüşümsüz boyut
    const k = Math.min(W / this.vb.width, H / this.vb.height);
    const ox = (W - this.vb.width * k) / 2, oy = (H - this.vb.height * k) / 2;
    const cx = ox + (bb.x + bb.width / 2) * k, cy = oy + (bb.y + bb.height / 2) * k;
    const s = Math.max(1.3, Math.min(2.6, (W * 0.3) / (bb.width * k), (H * 0.38) / (bb.height * k)));
    const tx = W / 2 - s * cx, ty = H / 2 - s * cy;
    this.svg.style.setProperty("--zk", s.toFixed(3)); // çizgi kalınlığı sabit kalsın
    this.stage.classList.toggle("instant", instant);
    this.stage.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
    this.zoomed = true;
    $("#zoom-reset").hidden = false;
  },

  resetZoom() {
    this.stage.classList.remove("instant");
    this.stage.style.transform = "";
    this.svg.style.removeProperty("--zk");
    this.zoomed = false;
    $("#zoom-reset").hidden = true;
  },
};

/* ------------------------------------------------------------------- İpucu */
const Tooltip = {
  on: false, raf: 0, x: -999, y: -999, tx: -999, ty: -999, cx: 0, cy: 0, w: 232, h: 170,
  init() {
    this.el = $("#tooltip");
    this.box = this.el.firstElementChild;
    this.r = Object.fromEntries(["plate", "region", "name", "value", "unit", "rank", "birth", "death", "birth-bar", "death-bar"]
      .map((k) => [k, $(`#tt-${k}`)]));
  },
  show(code) {
    const p = state.byCode.get(code);
    if (!p || mobile.matches) return;
    const m = METRICS[state.metric], r = this.r;
    r.plate.textContent = code.slice(3);
    r.region.textContent = `${p.region} Bölgesi`;
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
  Rank.markHot(code);
  if (!code) return Tooltip.hide();
  if (evt?.pointerType === "mouse") Tooltip.follow(evt.clientX, evt.clientY, !Tooltip.on);
  if (evt && evt.pointerType !== "touch") Tooltip.show(code);
}

/* ------------------------------------------------------------------ Lejant */
const Legend = {
  init() {
    this.list = $("#legend-scale");
    this.list.addEventListener("pointerover", (e) => { const li = e.target.closest("li"); if (li) MapView.highlightClass(+li.dataset.i); });
    this.list.addEventListener("pointerleave", () => MapView.highlightClass(null));
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
    raf2(() => this.list.querySelectorAll(".lg-hist i").forEach((el) => (el.style.transform = `scaleY(${el.dataset.s})`)));
  },
};

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
          <span class="rk-n"></span><span class="rk-name">${esc(p.province_name)}</span>
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

const Detail = {
  rows: new Map(), counterRaf: 0,
  init() {
    this.panel = $("#panel");
    this.view = $("#view-detail");
    const box = $("#dt-rows");
    box.innerHTML = DETAIL_METRICS.map((k) => `
      <div class="dt-row" data-k="${k}">
        <header><span class="dt-label">${METRICS[k].label}<span class="dt-year"></span></span><b class="dt-value"><span class="num">—</span><small>${METRICS[k].unit === "‰" ? "‰" : METRICS[k].unit}</small></b></header>
        <div class="dt-strip">
          <svg viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true"><path class="all"/><path class="peer"/><path class="nat"/></svg>
          <div class="dt-mark"><i></i></div>
        </div>
        <p class="dt-rank"></p>
        <div class="dt-trend" hidden>
          <svg viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true"><path class="line"/><circle class="end" r="2.2"/></svg>
          <span></span>
        </div>
      </div>`).join("");
    for (const row of box.children) {
      const k = row.dataset.k;
      this.rows.set(k, {
        num: $(".num", row), year: $(".dt-year", row), all: $(".all", row), peer: $(".peer", row), nat: $(".nat", row),
        mark: $(".dt-mark", row), rank: $(".dt-rank", row), cur: 0,
        trend: $(".dt-trend", row), line: $(".dt-trend .line", row), end: $(".dt-trend .end", row), trendText: $(".dt-trend span", row),
      });
    }
    $("#dt-back").addEventListener("click", () => deselect());
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.selected && !e.target.closest?.("input")) deselect(); });
  },

  /** Ölçek: nüfus ve yoğunluk log, diğerleri doğrusal. */
  pos(k, v) {
    const vals = state.provinces.map((p) => p[k]);
    const t = (x) => (METRICS[k].log ? Math.log10(Math.max(1, x)) : x);
    const lo = t(Math.min(...vals)), hi = t(Math.max(...vals));
    return Math.max(0, Math.min(100, ((t(v) - lo) / (hi - lo || 1)) * 100));
  },
  /** Tüm illerin çizgileri yalnızca veri değişince çizilir (tek path). */
  drawStrips() {
    for (const k of DETAIL_METRICS) {
      const r = this.rows.get(k);
      r.year.textContent = yearOf(k) ? ` (${yearOf(k)})` : "";
      r.all.setAttribute("d", state.provinces.map((p) => `M${this.pos(k, p[k]).toFixed(2)} 6V16`).join(""));
      const nat = k === "population" ? state.meta.national.avg_province_population : state.meta.national[k];
      r.nat.setAttribute("d", `M${this.pos(k, nat).toFixed(2)} 1V21`);
    }
  },

  open(code) {
    const p = state.byCode.get(code);
    if (!p) return;
    const nat = state.meta.national;
    $("#dt-plate").textContent = code.slice(3);
    $("#dt-region").textContent = `${p.region} Bölgesi`;
    $("#dt-name").textContent = p.province_name;
    const share = (p.population / nat.population) * 100;
    const rr = regionRank(p, "population");
    const ageDiff = p.median_age - nat.median_age;
    $("#dt-summary").textContent =
      `${p.region} Bölgesi'nin ${rr.rank === 1 ? "en kalabalık" : `${rr.rank}. kalabalık`} ili; Türkiye nüfusunun yüzde ${nf1.format(share)}'i burada yaşıyor. ` +
      `Ortanca yaş Türkiye ortalamasının ${Math.abs(ageDiff) < 0.5 ? "çok yakınında" : `${nf1.format(Math.abs(ageDiff))} yıl ${ageDiff > 0 ? "üstünde" : "altında"}`}.`;

    const peers = state.provinces.filter((x) => x.region === p.region);
    const anim = [];
    for (const k of DETAIL_METRICS) {
      const r = this.rows.get(k);
      r.peer.setAttribute("d", peers.map((x) => `M${this.pos(k, x[k]).toFixed(2)} 3V19`).join(""));
      r.mark.style.transform = `translateX(${this.pos(k, p[k]).toFixed(2)}%)`;
      const pr = regionRank(p, k);
      r.rank.textContent = `81 il içinde ${p.ranks[k]}., bölgede ${pr.rank}/${pr.of}`;
      anim.push({ r, k, from: r.cur, to: p[k] });
      r.cur = p[k];
      this.trend(r, k, p.history?.[k]);
    }
    this.count(anim);
    this.panel.classList.add("detail");
    this.view.setAttribute("aria-hidden", "false");
    $("#view-rank").setAttribute("aria-hidden", "true");
    this.view.scrollTop = 0;
  },

  /** Yıllık seri: küçük çizgi + ilk/son yıl farkı. */
  trend(r, k, series) {
    const pts = Object.entries(series || {}).map(([y, v]) => [+y, v]).sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) { r.trend.hidden = true; return; }
    const ys = pts.map((p) => p[1]);
    const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
    const x = (i) => (i / (pts.length - 1)) * 100, y = (v) => 19 - ((v - lo) / span) * 16;
    r.line.setAttribute("d", pts.map(([, v], i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(""));
    // daire viewBox'ta yatayda gerilmesin diye son noktayı yüzdeyle değil, sağ kenarda çiziyoruz
    r.end.setAttribute("cx", "100");
    r.end.setAttribute("cy", y(ys.at(-1)).toFixed(1));
    const [y0, v0] = pts[0], [y1, v1] = pts.at(-1);
    const diff = v1 - v0;
    const change = k === "population" || k === "population_density"
      ? `${diff >= 0 ? "+" : "−"}%${nf1.format(Math.abs(diff / v0) * 100)}`
      : `${diff >= 0 ? "+" : "−"}${nf1.format(Math.abs(diff))}`;
    r.trendText.textContent = `${y0}–${y1}: ${change}`;
    r.trend.hidden = false;
  },

  close() {
    this.panel.classList.remove("detail");
    this.view.setAttribute("aria-hidden", "true");
    $("#view-rank").setAttribute("aria-hidden", "false");
  },

  /** Sayaçlar: tek rAF döngüsü, easeOutExpo. */
  count(items) {
    cancelAnimationFrame(this.counterRaf);
    const t0 = performance.now(), dur = motionOK ? 700 : 1;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur), e = t === 1 ? 1 : 1 - 2 ** (-10 * t);
      for (const { r, k, from, to } of items) r.num.textContent = fmt(k, from + (to - from) * e);
      if (t < 1) this.counterRaf = requestAnimationFrame(step);
    };
    this.counterRaf = requestAnimationFrame(step);
  },
};

function select(code, { zoom = false, push = true } = {}) {
  if (!state.byCode.has(code)) return;
  state.selected = code;
  MapView.markSelected(code);
  Rank.markSelected(code);
  Table.markSelected(code);
  Detail.open(code);
  if (zoom && !state.tabular) MapView.focus(code);
  writeUrl(push);
}

function deselect({ push = true } = {}) {
  state.selected = null;
  MapView.markSelected(null);
  Rank.markSelected(null);
  Table.markSelected(null);
  Detail.close();
  MapView.resetZoom();
  writeUrl(push);
}

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
    if (on) { MapView.resetZoom(); this.highlight(); this.view.focus({ preventScroll: true }); }
    else if (state.selected) MapView.focus(state.selected);
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
          return `<li role="option" id="sl-${i}" data-code="${p.plate_code}" aria-selected="${i === 0}"><span class="plate">${p.plate_code.slice(3)}</span><span>${label}</span><span class="sl-region">${esc(p.region)}</span></li>`;
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
  MapView.paint(animate);
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
      Detail.drawStrips();
      restyle(true);
      renderLede(true);
      if (state.selected) Detail.open(state.selected);
    }
  } catch {
    Status.render("error");
  }
}

function initTheme() {
  const btn = $("#theme-toggle");
  const label = () => btn.setAttribute("aria-label", state.theme() === "dark" ? "Gündüz temasına geç" : "Gece temasına geç");
  label();
  btn.addEventListener("click", () => {
    const next = state.theme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    $('meta[name="theme-color"]').content = next === "dark" ? "#101A2E" : "#F3F5F4";
    try { localStorage.setItem("tna-theme", next); } catch { /* yok say */ }
    label();
    restyle(true);
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
  Legend.init();
  Tabs.init();
  Rank.init();
  Detail.init();
  Detail.drawStrips();
  Search.init();
  Table.init();

  const h = readUrl();
  state.metric = h.metric || "population";
  restyle(false);
  // İl sayfasında başlık sunucudan gelir (o ile özel); metrik değişince genel başlığa geçilir
  if (document.body.dataset.page !== "province" || h.metric) renderLede(false);
  // Tek orkestrasyon anı: harita belirir, çubuklar ve histogram büyür
  document.body.classList.add("ready");
  if (h.code && state.byCode.has(h.code)) {
    setTimeout(() => { select(h.code, { zoom: true, push: false }); Rank.reveal(h.code); }, 450);
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
