/* Cadence family engine — GENERATED from docs/app.js by
   scripts/build_family_engine.py. Do not edit by hand; edit the DCI app or
   the build script and regenerate. Instances configure via window.APP_CFG:
   { appName, root, ns, board, captions, classOrder, combinable,
     terms:{singular,plural,a}, eventsTitle } */
/* Cadence SPA — Scoreboard · Shows · Corps · Stats (hash-routed, no build) */
(function () {
  const app = document.getElementById("app");
  const { lineChart, sparkline, PALETTE, esc } = window.CCViz;
  const cache = new Map();
  // --- Cadence family config (absent on the DCI app, set by instances) ---
  const FAM = window.APP_CFG || null;
  const NS = k => (FAM ? FAM.ns : "") + k;
  const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);
  const TERM = FAM ? FAM.terms : { singular: "corps", plural: "corps", a: "a corps" };
  const TERM_TH = FAM ? cap1(FAM.terms.singular) : "Corps";
  // Does this app publish judge-level caption sheets? The DCI app always
  // does; a family instance says so in its config (WGI ships captions:false
  // because WGI's sheets are behind its directors-only portal). Every
  // caption surface — the Stats sub-tab, the corps-profile tile, the
  // Database dataset, the per-event recap fetch — is gated on this, so a
  // captionless app never shows a control that leads nowhere.
  const CAPS = !FAM || !!FAM.captions;
  // Each screen says once, plainly, what this app's data does NOT cover —
  // an app with no in-season scores must explain the empty column rather
  // than just look broken. One sentence per screen, from the instance
  // config; the DCI app has full coverage and renders none of them.
  const NOTE = k => (FAM && FAM.notes && FAM.notes[k]) || "";
  const noteHtml = k => NOTE(k) ? `<div class="notice">${esc(NOTE(k))}</div>` : "";


  async function data(path) {
    if (cache.has(path)) return cache.get(path);
    const p = fetch("data/" + path).then(r => {
      if (!r.ok) throw new Error(path + " " + r.status);
      return r.json();
    });
    cache.set(path, p);
    try { return await p; } catch (e) { cache.delete(path); throw e; }
  }

  // ---- live-show detection: which corps / shows are performing RIGHT NOW ----
  // Reads the published schedule (per-corps ET performance times) + today's
  // posted scores. A corps is "live" for a tight window around its slot (15 min
  // either side — roughly on-deck through walk-off), unless its score for today
  // is already in. A whole show goes dark the moment its full results land, even
  // if the clock is still inside the window. DCI championship venues run on
  // Eastern time; August is EDT (UTC-4).
  // The decision rules live in docs/lib/live-core.js (pure + unit-tested);
  // this module owns the fetching, 30-second cache, and lookup API.
  const LIVE = (() => {
    const CORE = window.CadLiveCore;
    let cache = null, cacheAt = 0;
    const etToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    async function refresh(force) {
      const now = Date.now();
      if (!force && cache && now - cacheAt < 30000) return cache;
      const today = etToday();
      let up = [], season = null;
      if (!FAM) {   // family circuits publish no live-scoring feed
        try { up = await data("upcoming.json"); } catch (e) {}
        try { season = await data(`seasons/${+today.slice(0, 4)}.json`); } catch (e) {}
      }
      // stamp each show with its venue zone before the core does any clock
      // maths; live-core has no state table of its own.
      (up || []).forEach(e => { if (!e.tz) e.tz = venueZone(e.location) || undefined; });
      cache = { ...CORE.compute(up, season, today, now), today }; cacheAt = now;
      return cache;
    }
    return {
      refresh,
      corpsLive: n => !!(cache && cache.corpsLive.has(n)),
      showLive: ev => !!(cache && ev && cache.showLive.has(ev.name)),
      // a show whose full results are in — nothing about it is live any more
      isComplete: name => !!(cache && cache.complete.has(name)),
      scored: n => !!(cache && cache.scored.has(n)),
      // is a specific schedule slot inside its ±15-min live window right now?
      // (corps and logistics rows alike — the caller gates on show-completeness)
      // tz is the venue's zone (from its state) so the pill agrees with the
      // start time printed beside it — see live-core's slotMs.
      slotLiveAt: (dateISO, timeStr, tz) => CORE.slotLiveAt(dateISO, timeStr, Date.now(), tz),
      today: () => cache && cache.today,
      // signature of the current live sets — lets a view repaint only on change
      sig: () => cache ? [...cache.corpsLive].sort().join("|") + "#" + [...cache.showLive].sort().join("|") : "",
    };
  })();
  const LIVE_BADGE = '<span class="pill live" title="Performing now — scores landing"><span class="livedot"></span>LIVE</span>';

  const score3 = v => v == null ? "—" : (+v).toFixed(3);
  const h = (strings, ...vals) => strings.map((s, i) => s + (vals[i] == null ? "" : vals[i])).join("");

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    return `${MONTHS[m - 1]} ${d}`;
  }
  function fmtDateY(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    return `${MONTHS[m - 1]} ${d}, ${y}`;
  }
  // stacked date for table cells: "Jul 10" with the year underneath
  function fmtDate2(iso, fallback) {
    if (!iso) return fallback == null ? "" : esc(String(fallback));
    const [y, m, d] = iso.split("-").map(Number);
    return `<span class="dstack">${MONTHS[m - 1]} ${d}<small>${y}</small></span>`;
  }
  function dayOfSeason(iso) { // days since May 31 of that year
    const [y, m, d] = iso.split("-").map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 4, 31)) / 86400000);
  }
  function dayLabel(day) { // inverse for a non-leap reference
    const dt = new Date(Date.UTC(2001, 4, 31 + Math.round(day)));
    return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
  }

  function deltaHtml(d) {
    if (d == null) return '<span class="delta flat">—</span>';
    if (Math.abs(d) < 0.001) return '<span class="delta flat">±0.0</span>';
    return `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(2)}</span>`;
  }
  const slugOf = name => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  /* ===== stable per-corps colors =====
     Identity-informed for the marquee corps (blues separated into navy /
     cyan / indigo, reds into scarlet / crimson so nothing reads alike),
     stable hash into a spread 16-color palette for everyone else.
     The same corps gets the same color on every page, chart and filter. */
  const CORPS_COLORS = {
    "Blue Devils": "#1c4a99",        // navy
    "Bluecoats": "#0c8599",          // cyan-teal
    "Blue Knights": "#3b5bdb",       // indigo
    "Carolina Crown": "#9c36b5",     // crown purple
    "Santa Clara Vanguard": "#f03e3e", // scarlet
    "Boston Crusaders": "#a61e1e",   // dark crimson
    "The Cavaliers": "#2f9e44",      // kelly green
    "Madison Scouts": "#1e6b30",     // forest green
    "Phantom Regiment": "#343a40",   // graphite (black & white corps)
    "The Cadets": "#85144b",         // maroon
    "Mandarins": "#e8590c",          // orange
    "Colts": "#b35c00",              // burgundy-brown
    "Blue Stars": "#d6336c",         // red side of their red/blue
    "Crossmen": "#846358",           // bronze
    "Blue Devils B": "#356fc4",      // lighter than the A corps
  };
  const EXT_PALETTE = [
    "#e8590c", "#1971c2", "#2f9e44", "#6741d9", "#c2255c", "#0c8599",
    "#a61e4d", "#495057", "#b35c00", "#66a80f", "#f03e3e", "#9c36b5",
    "#3b5bdb", "#d6336c", "#087f5b", "#846358",
  ];
  function corpsColor(name) {
    const n = String(name || "");
    if (CORPS_COLORS[n]) return CORPS_COLORS[n];
    let hsum = 0;
    for (let i = 0; i < n.length; i++) hsum = (hsum * 31 + n.charCodeAt(i)) >>> 0;
    return EXT_PALETTE[hsum % EXT_PALETTE.length];
  }

  /* ===== corps color themes =====
     Pick your corps in Settings and the whole app takes on its colors. Each
     corps is a TWO-color identity — a dark brand color (bar: the topbar and
     dark UI) and a bright accent (buttons, links, active tab). Two colors is
     what keeps same-hue corps apart: Boston, Phantom and Santa Clara are all
     "red", but Boston reads maroon/red, Phantom black/red, and Vanguard
     red/green — clearly different. From the pair we derive ink, wash, a
     light-bg link tint and legible on-color text. Unlisted corps fall back to
     their stable chart color, darkened for the bar. (These are separate from
     the chart-legend colors, which optimize for line separation, not identity.) */
  const CORPS_THEME = {
    // [ bar (dark brand), accent (bright) ]
    "Blue Devils": ["#0f2f66", "#2f6fd0"], "Bluecoats": ["#0a3f6b", "#1aa6c9"],
    "Boston Crusaders": ["#5e1119", "#d2222d"], "Carolina Crown": ["#3f1d6b", "#f0b429"],
    "The Cadets": ["#5c162c", "#e0a92e"], "The Cavaliers": ["#123019", "#2fa14a"],
    "Phantom Regiment": ["#1b1b1e", "#d81f26"], "Santa Clara Vanguard": ["#8f1620", "#2e9e46"],
    "Blue Knights": ["#14224f", "#3b5bdb"], "Blue Stars": ["#123a7a", "#f0b429"],
    "Crossmen": ["#1a1a1a", "#d4a017"], "Madison Scouts": ["#0e4423", "#e6c02e"],
    "Mandarins": ["#6f1512", "#eab308"], "Colts": ["#8a1626", "#4da3e0"],
    "Spirit of Atlanta": ["#8a1626", "#2f6fd0"], "The Academy": ["#182a5e", "#c9a227"],
    "Pacific Crest": ["#0c4f45", "#e8590c"], "Music City": ["#33206b", "#12a5b0"],
    "Genesis": ["#0a3a40", "#12a0a0"], "Seattle Cascades": ["#0e4a3d", "#2fa14a"],
    "Jersey Surf": ["#123a5e", "#14aabd"], "Troopers": ["#8a1626", "#2b6cd4"],
    "Gold": ["#1c1c18", "#c9a227"], "Raiders": ["#1a1a1a", "#c8202f"],
    "The Battalion": ["#152a52", "#e8590c"], "Golden Empire": ["#1c1c18", "#c9a227"],
    "Guardians": ["#14224f", "#8a94a6"], "Colt Cadets": ["#8a1626", "#4da3e0"],
    "Vessel": ["#123a5e", "#14aabd"], "Impulse": ["#1a1a1a", "#e8590c"],
    "Legends": ["#123019", "#d4a017"], "River City Rhythm": ["#33206b", "#12a5b0"],
    "Les Stentors": ["#0f2f66", "#d2222d"], "7th Regiment": ["#5e1119", "#c9a227"],
    "Southwind": ["#0c4f45", "#e6c02e"], "Heat Wave": ["#8a1626", "#e8590c"],
  };
  // marquee corps to surface as one-tap color chips (only those with data show)
  const THEME_FEATURED = [
    "Blue Devils", "Bluecoats", "Boston Crusaders", "Carolina Crown", "The Cavaliers",
    "Phantom Regiment", "The Cadets", "Blue Knights", "Blue Stars", "Mandarins",
    "Colts", "Crossmen", "Madison Scouts", "Santa Clara Vanguard",
  ];
  const _hx = s => {
    s = String(s || "").replace("#", "");
    if (s.length === 3) s = [...s].map(c => c + c).join("");
    const n = parseInt(s, 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const _mix = (a, b, t) => a.map((c, i) => Math.round(c * (1 - t) + b[i] * t));
  const _rgb = a => "#" + a.map(c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("");
  const _lum = a => { // WCAG relative luminance 0..1
    const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(a[0]) + 0.7152 * f(a[1]) + 0.0722 * f(a[2]);
  };
  const _onColor = a => { // black or white — whichever reads better on `a`
    const L = _lum(a);
    return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? "#15130f" : "#ffffff";
  };
  // resolve a corps to its {bar, accent} pair (curated, or derived from its
  // chart color for the long tail)
  function corpsPair(name) {
    const p = CORPS_THEME[name];
    if (p) return { bar: p[0], accent: p[1] };
    const base = corpsColor(name);
    return { bar: _rgb(_mix(_hx(base), [16, 18, 26], 0.6)), accent: base };
  }
  const corpsAccent = name => corpsPair(name).accent;
  // build the full CSS-variable set from any {bar, accent} pair — shared by the
  // curated corps themes and the custom color picker
  function themeVarsFromPair(barHex, accentHex) {
    let barRgb = _hx(barHex);
    if (_lum(barRgb) > 0.26) barRgb = _mix(barRgb, [14, 16, 24], 0.5); // topbar must stay dark for white text
    const acc = _hx(accentHex);
    return {
      accent: accentHex,
      bar: _rgb(barRgb),
      ink: _rgb(_mix(acc, [10, 10, 10], 0.34)),
      light: _rgb(_mix(acc, [255, 255, 255], 0.36)),
      onAccent: _onColor(acc),
      wash: `rgba(${acc[0]},${acc[1]},${acc[2]},0.15)`,
    };
  }
  function corpsThemeVars(name) {
    const pair = corpsPair(name);
    let barRgb = _hx(pair.bar);
    if (_lum(barRgb) > 0.26) barRgb = _mix(barRgb, [14, 16, 24], 0.5); // topbar must stay dark for white text
    const acc = _hx(pair.accent);
    return {
      accent: pair.accent,
      bar: _rgb(barRgb),
      ink: _rgb(_mix(acc, [10, 10, 10], 0.34)),   // darker accent for text on light
      light: _rgb(_mix(acc, [255, 255, 255], 0.36)), // brighter link on dark bg
      onAccent: _onColor(acc),                    // legible text on the bright accent
      wash: `rgba(${acc[0]},${acc[1]},${acc[2]},0.15)`,
    };
  }
  function corpsThemeCSSFromVars(v) {
    const base = `--navy:${v.bar};--gold:${v.accent};--accent:${v.accent};--accent-ink:${v.ink};--accent-wash:${v.wash};--on-accent:${v.onAccent};--link:${v.bar};--heading:${v.bar};`;
    const dark = `--link:${v.light};--heading:#e8ecf5;`;
    const light = `--link:${v.bar};--heading:${v.bar};`;
    // Doubled [data-corps] lifts specificity above app.css's own theme rules so
    // the override wins regardless of stylesheet order; paired with .viz-root so
    // it reaches content inside <main> the same way the base theme does.
    const S = "[data-corps][data-corps]";
    return `:root${S},:root${S} .viz-root{${base}}`
      + `@media (prefers-color-scheme:dark){:root${S}:not([data-theme="light"]),:root${S}:not([data-theme="light"]) .viz-root{${dark}}}`
      + `:root${S}[data-theme="dark"],:root${S}[data-theme="dark"] .viz-root{${dark}}`
      + `:root${S}[data-theme="light"],:root${S}[data-theme="light"] .viz-root{${light}}`;
  }
  // write a theme (curated corps, custom pair, or none) to the page + storage
  function writeTheme(slug, css, bar, extra) {
    let el = document.getElementById("corpsTheme");
    if (!el) { el = document.createElement("style"); el.id = "corpsTheme"; document.head.appendChild(el); }
    const root = document.documentElement;
    ["cad-corps-theme", "cad-corps-css", "cad-corps-bar", "cad-corps-custom"].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
    if (!slug) {
      el.textContent = "";
      root.removeAttribute("data-corps");
    } else {
      el.textContent = css;
      root.setAttribute("data-corps", slug);
      try {
        localStorage.setItem("cad-corps-theme", extra && extra.name != null ? extra.name : slug);
        localStorage.setItem("cad-corps-css", css);
        localStorage.setItem("cad-corps-bar", bar);
        if (extra && extra.custom) localStorage.setItem("cad-corps-custom", JSON.stringify(extra.custom));
      } catch (e) {}
    }
    if (window.CadTheme && window.CadTheme.paintMeta) window.CadTheme.paintMeta();
  }
  function applyCorpsTheme(name) {
    if (!name) return writeTheme(null);
    const v = corpsThemeVars(name);
    writeTheme(slugOf(name), corpsThemeCSSFromVars(v), v.bar, { name });
  }
  // custom user-chosen primary (bar) + accent — "__custom__" is its stored name
  function applyCustomTheme(barHex, accentHex) {
    const v = themeVarsFromPair(barHex, accentHex);
    writeTheme("custom", corpsThemeCSSFromVars(v), v.bar, { name: "__custom__", custom: [barHex, accentHex] });
  }
  const currentCorpsTheme = () => { try { return localStorage.getItem("cad-corps-theme") || ""; } catch (e) { return ""; } };
  const currentCustom = () => { try { const c = JSON.parse(localStorage.getItem("cad-corps-custom") || "null"); return Array.isArray(c) && c.length === 2 ? c : null; } catch (e) { return null; } };
  window.CadCorps = { apply: applyCorpsTheme, custom: applyCustomTheme, current: currentCorpsTheme, vars: corpsThemeVars, accent: corpsAccent };
  // whole-app text scaling — zoom on the root reflows like browser zoom, so
  // the mobile layout still adapts and nothing overflows sideways
  function applyFontSize(scale) {
    const s = String(scale || "1");
    const de = document.documentElement;
    de.style.zoom = s === "1" ? "" : s;
    // zoom shrinks the layout viewport but NOT vw/vh units or media queries, so
    // publish the scale: `calc(<n>vw / var(--fs))` converts a visual-pixel size
    // into the layout units the zoomed page actually has, and [data-fs] lets the
    // CSS tighten up where the breakpoints can no longer see the real width.
    de.style.setProperty("--fs", s);
    if (s === "1") de.removeAttribute("data-fs"); else de.setAttribute("data-fs", s);
    try { s === "1" ? localStorage.removeItem("cad-fontsize") : localStorage.setItem("cad-fontsize", s); } catch (e) {}
  }
  window.CadFontSize = applyFontSize;
  // official corps logos come from the Wikipedia-sourced profiles (same source
  // the corps page already uses). Show one next to the name where we have it,
  // and fall back to the two-tone color swatch where we don't. Images are
  // hotlinked, never copied into the app.
  let _logos = null;
  async function ensureLogos() {
    if (_logos) return _logos;
    try { _logos = await data("profiles.json"); } catch (e) { _logos = {}; }
    return _logos;
  }
  // Some profile images are performance/parade photos, not logos — those look
  // like random pictures at badge size, so only treat a URL as a logo when its
  // filename actually reads like one (or it's an SVG, which logos almost always
  // are). Everything else falls back to the color swatch.
  function isLogoUrl(url) {
    let u = String(url || "").toLowerCase();
    try { u = decodeURIComponent(u); } catch (e) {}
    if (!u) return false;
    return u.includes(".svg") || /logo|shield|insignia|crest|emblem|wordmark|badge|seal/.test(u);
  }
  // Curated logo URLs that take precedence over the auto-scraped profile image
  // (used when the profile captured a performance photo instead of the logo, or
  // when the profile has no image). Same Wikimedia source the app already uses;
  // lives in code so the data pipeline can't overwrite it.
  const CORPS_LOGO = {
    "Carolina Crown": "https://upload.wikimedia.org/wikipedia/commons/4/4e/Carolina_Crown_Drum_and_Bugle_Corps_Crown_Logo.png",
    "Madison Scouts": "https://upload.wikimedia.org/wikipedia/en/2/24/Madison_Scouts_Corps.png",
    "The Academy": "https://upload.wikimedia.org/wikipedia/en/2/25/The_Academy_Drum_and_Bugle_Corps.png",
    "Music City": "https://upload.wikimedia.org/wikipedia/en/9/9b/Music_City_Drum_and_Bugle_Corps.png",
    "Crossmen": "https://upload.wikimedia.org/wikipedia/en/1/15/Crossmen_logo.png",
    "Seattle Cascades": "https://upload.wikimedia.org/wikipedia/en/0/0b/Cascades_Drum_and_Bugle_Corps_50th_Anniversary_logo.png",
    "Blue Stars": "https://upload.wikimedia.org/wikipedia/en/thumb/6/64/Blue_Stars_Drum_and_Bugle_Corps_Logo%2C_2021.svg/330px-Blue_Stars_Drum_and_Bugle_Corps_Logo%2C_2021.svg.png",
    "Blue Knights": "https://upload.wikimedia.org/wikipedia/en/thumb/9/9c/Blue_Knights_Drum_and_Bugle_Corps_Logo%2C_2021.svg/330px-Blue_Knights_Drum_and_Bugle_Corps_Logo%2C_2021.svg.png",
    "Genesis": "https://upload.wikimedia.org/wikipedia/en/thumb/d/d2/Genesis_Drum_and_Bugle_Corps_Logo%2C_2021.svg/330px-Genesis_Drum_and_Bugle_Corps_Logo%2C_2021.svg.png",
    "The Cadets": "https://upload.wikimedia.org/wikipedia/en/thumb/d/d8/The_Cadets_Drum_and_Bugle_Corps_Logo%2C_2021.svg/330px-The_Cadets_Drum_and_Bugle_Corps_Logo%2C_2021.svg.png",
  };
  const logoOf = name => {
    if (CORPS_LOGO[name]) return CORPS_LOGO[name];
    const p = _logos && _logos[slugOf(name)];
    return p && p.img && isLogoUrl(p.img) ? p.img : null;
  };
  const corpsHasLogo = name => !!logoOf(name);
  function corpsLogo(name, size, url) {
    const s = size || 24;
    const v = corpsThemeVars(name);
    const img = (url && isLogoUrl(url) ? url : null) || logoOf(name);
    // if the image 404s or is blocked, it removes itself and the color swatch shows
    // profiles URLs are already percent-encoded — esc() (not encodeURI, which
    // would re-encode the % and 404 the image) just makes it attribute-safe
    const inner = img ? `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()">` : "";
    return `<span class="corpslogo" style="width:${s}px;height:${s}px;--c1:${v.bar};--c2:${v.accent}">${inner}</span>`;
  }
  window.corpsLogo = corpsLogo;
  const FAVS = (() => {
    let set;
    try { set = new Set(JSON.parse(localStorage.getItem(NS("cad-favs")) || "[]")); }
    catch (e) { set = new Set(); }
    return {
      has: n => set.has(n),
      list: () => [...set],
      toggle: n => {
        set.has(n) ? set.delete(n) : set.add(n);
        localStorage.setItem(NS("cad-favs"), JSON.stringify([...set]));
      },
    };
  })();

  function corpsLink(name) {
    const fav = FAVS.has(name);
    return `<a href="#/corps/${slugOf(name)}"${fav ? ' class="favname"' : ""}>${fav ? "★ " : ""}${esc(name)}</a>`;
  }

  /* ===== first-run onboarding: "Who do you follow?" =====
     One skippable sheet, shown once. Picking corps just drives the existing
     ★ favorites store — no separate preference model. After a pick, offers
     score alerts (existing CadPush) behind an explicit tap, never an
     automatic permission prompt. Reopenable any time from Settings. */
  const CadOnboard = (() => {
    const KEY = "cad-onboard";           // versioned: bump the value to re-run
    const DONE_VAL = "1";
    const storageOK = (() => {
      try { localStorage.setItem("cad-t", "1"); localStorage.removeItem("cad-t"); return true; }
      catch (e) { return false; }
    })();
    const seen = () => { try { return localStorage.getItem(KEY) === DONE_VAL; } catch (e) { return true; } };
    const markSeen = () => { try { localStorage.setItem(KEY, DONE_VAL); } catch (e) {} };
    // Claim the first-visit popup slot NOW, at script-eval time — recap.js and
    // install.js load after app.js and check these before auto-popping, so
    // onboarding goes first and their nudges wait for a later visit.
    const due = storageOK && !seen() && !FAVS.list().length;
    if (due) {
      try { sessionStorage.setItem("cad-rc-session", "1"); } catch (e) {}
      try {
        const cur = +(localStorage.getItem("cad-install-snooze") || 0);
        if (cur < Date.now() + 864e5) localStorage.setItem("cad-install-snooze", String(Date.now() + 864e5));
      } catch (e) {}
    }

    let ov = null, lastFocus = null, onClose = null;
    function close() {
      if (!ov) return;
      ov.remove(); ov = null;
      document.documentElement.style.overflow = "";
      if (lastFocus && lastFocus.isConnected) { try { lastFocus.focus(); } catch (e) {} }
      // the Following strip may need to appear/refresh with the new stars
      if ((location.hash || "#/") === "#/") route();
      const cb = onClose; onClose = null;
      if (cb) { try { cb(); } catch (e) {} }
    }

    function chipHtml(name) {
      const on = FAVS.has(name);
      return `<button type="button" class="ob-chip${on ? " on" : ""}" data-corps="${esc(name)}"
        aria-pressed="${on}">${corpsLogo(name, 22)}<span class="ob-chip-n">${esc(name)}</span></button>`;
    }

    async function open(replay, closedCb) {
      if (ov) return;
      onClose = closedCb || null;
      let rk;
      try { rk = await data("rankings.json"); } catch (e) { if (!replay) markSeen(); return; }
      /* File each corps under the class it actually belongs to, once.
         rk.standings is keyed by the board a corps competed on, and Open Class
         corps run World Class prelims at Championships — so reading these
         buckets straight put River City Rhythm under WORLD CLASS and again
         under OPEN CLASS, alongside ten other Open Class corps. The board is
         right (they did compete there); using it as a corps' class is not.
         build_data.py resolves the real one as `home_class`; fall back to the
         bucket on data built before that existed. */
      const seen = new Set();
      const byClass = new Map();
      sortClasses(Object.keys(rk.standings || {})).forEach(cls =>
        (rk.standings[cls].rows || []).slice().sort((a, b) => a.rank - b.rank).forEach(r => {
          if (seen.has(r.corps)) return;
          seen.add(r.corps);
          const home = r.home_class || cls;
          if (!byClass.has(home)) byClass.set(home, []);
          byClass.get(home).push(r);
        }));
      const groups = sortClasses([...byClass.keys()])
        .map(c => ({ cls: c, rows: byClass.get(c) }))
        .filter(g => g.rows.length);
      if (!groups.length && FAM) {
        // no standings (no published score feed) — offer the whole roster
        try {
          const roster = await data("corps_index.json");
          if (roster && roster.length) {
            groups.push({ cls: "All " + TERM.plural, rows: roster.map(c => ({ corps: c.name })) });
          }
        } catch (e) {}
      }
      if (!groups.length) { if (!replay) markSeen(); return; }

      lastFocus = document.activeElement;
      ov = document.createElement("div");
      ov.className = "ob-ov";
      ov.innerHTML = `
        <div class="ob-sheet" role="dialog" aria-modal="true" aria-labelledby="obTitle">
          <h2 id="obTitle">Who do you follow?</h2>
          <p class="ob-sub">${FAM ? "Star your " + TERM.plural + " — they lead every board and table in this app." : "Star your corps — the scoreboard and score alerts get personalized around them."}</p>
          <input class="ctrl ob-search" type="search" placeholder="Search ${TERM.plural}…" aria-label="Search ${TERM.plural}">
          <div class="ob-list">${groups.map(g =>
            `<div class="ob-cls">${esc(g.cls)}</div><div class="ob-grid">${g.rows.map(r => chipHtml(r.corps)).join("")}</div>`).join("")}
          </div>
          <div class="ob-foot">
            <button type="button" class="tab" id="obSkip">${replay ? "Close" : "Skip"}</button>
            <button type="button" class="tab on" id="obDone">Done</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      document.documentElement.style.overflow = "hidden";
      const sheet = ov.querySelector(".ob-sheet");
      const doneBtn = ov.querySelector("#obDone");
      const paintDone = () => {
        const n = FAVS.list().length;
        doneBtn.textContent = n ? `Done · following ${n}` : "Done";
      };
      paintDone();
      ov.addEventListener("click", e => {
        if (e.target === ov) { finish(); return; }              // backdrop = skip
        const chip = e.target.closest(".ob-chip");
        if (chip) {
          FAVS.toggle(chip.dataset.corps);
          chip.classList.toggle("on");
          chip.setAttribute("aria-pressed", chip.classList.contains("on"));
          paintDone();
        }
      });
      ov.querySelector(".ob-search").addEventListener("input", e => {
        const q = e.target.value.trim().toLowerCase();
        ov.querySelectorAll(".ob-chip").forEach(c => {
          c.hidden = !!q && !c.dataset.corps.toLowerCase().includes(q);
        });
        ov.querySelectorAll(".ob-cls").forEach(hd => {
          const grid = hd.nextElementSibling;
          const any = grid && [...grid.children].some(c => !c.hidden);
          hd.hidden = !any; if (grid) grid.hidden = !any;
        });
      });
      ov.addEventListener("keydown", e => { if (e.key === "Escape") finish(); });
      ov.querySelector("#obSkip").onclick = finish;
      doneBtn.onclick = async () => {
        if (!replay) markSeen();
        // contextual alerts offer — only when it could actually work and the
        // user just chose someone to follow. Never triggers the permission
        // prompt itself; that stays behind its own explicit tap below.
        const favs = FAVS.list();
        const P = window.CadPush;
        let show = false;
        if (favs.length && P) {
          try {
            // status() waits on serviceWorker.ready — race it so an
            // environment with no service worker can't hang the sheet
            const st = await Promise.race([P.status(), new Promise(r => setTimeout(() => r("unknown"), 1200))]);
            show = st !== "on" && st !== "unknown"
              && (!("Notification" in window) || Notification.permission !== "denied");
          } catch (e) {}
        }
        if (!show) { close(); return; }
        sheet.innerHTML = `
          <h2 id="obTitle">Want a ping when ${esc(favs[0])} scores post?</h2>
          <p class="ob-sub">Score alerts are free and sent the moment results land — your starred
            corps lead the notification. You can turn them off any time in Settings.</p>
          <div class="ob-foot">
            <button type="button" class="tab" id="obLater">Not now</button>
            <button type="button" class="tab on" id="obAlerts">Turn on score alerts</button>
          </div>
          <p class="ob-note" id="obNote" role="status"></p>`;
        sheet.querySelector("#obLater").onclick = close;
        sheet.querySelector("#obAlerts").onclick = async () => {
          const note = sheet.querySelector("#obNote");
          note.textContent = "Setting up…";
          try {
            const r = await P.enable();
            if (r && r.ok) {
              note.textContent = "Alerts are on — a test ping lands in ~15 seconds.";
              setTimeout(close, 2200);
            } else {
              note.textContent = (r && r.reason) || "Notifications weren't allowed — you can change that in your browser settings.";
            }
          } catch (e) { note.textContent = "Couldn't reach the alert server — try again from Settings later."; }
        };
      };
      try { sheet.focus({ preventScroll: true }); } catch (e) {}
      sheet.setAttribute("tabindex", "-1");
      sheet.focus();
      function finish() { if (!replay) markSeen(); close(); }
    }

    function maybeShow() {
      if (FAM) return;   // secondary apps: reachable from Settings, never a first-visit popup
      if (!storageOK || seen()) return;
      if (FAVS.list().length) { markSeen(); return; }   // existing users: never nag
      if (document.querySelector(".sr-overlay,.rc-overlay,.ar-overlay,.in-ov,.ob-ov")) return;
      // take this session's popup slot so the recap catch-up waits for the
      // next visit instead of stacking on top of onboarding
      try { sessionStorage.setItem("cad-rc-session", "1"); } catch (e) {}
      open(false);
    }
    return { maybeShow, open };
  })();
  // ---- inline icon set — the nav's stroke style, sized for running text ----
  const icoSvg = (paths, size = 15) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px">${paths}</svg>`;
  const ICO_TROPHY = '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 5H4v2a3 3 0 0 0 3 3"/><path d="M17 5h3v2a3 3 0 0 1-3 3"/>';
  const ICO_TARGET = '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r=".6"/>';
  const ICO_TICKET = '<path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z"/><path d="M13 5v2M13 11v2M13 17v2"/>';
  const ICO_PHONE = '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18.5h2"/>';
  const TARGET_SVG = icoSvg(ICO_TARGET);
  // ---- share: native share sheet, clipboard fallback -----------------------
  const SHARE_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>';
  function flashBtn(btn, msg) {
    if (!btn) return;
    if (btn.dataset.orig == null) btn.dataset.orig = btn.innerHTML;
    btn.innerHTML = msg;
    clearTimeout(btn._ft);
    btn._ft = setTimeout(() => { btn.innerHTML = btn.dataset.orig; delete btn.dataset.orig; }, 1500);
  }
  async function shareView(btn, title, url) {
    const u = url || location.href;
    if (navigator.share) { try { await navigator.share({ title: title || "Cadence", url: u }); } catch (e) {} return; }
    try { await navigator.clipboard.writeText(u); flashBtn(btn, "Link copied ✓"); }
    catch (e) { try { window.prompt("Copy this link:", u); } catch (e2) {} }
  }
  // attach a share button (rendered elsewhere) to share the current deep link
  function wireShare(id, title) {
    const sb = document.getElementById(id);
    if (sb) sb.addEventListener("click", () => shareView(sb, title, location.href));
  }
  // stable per-show key — the same event keeps its key across data refreshes
  const pinKeyOf = ev => (ev.date || "") + "|" + (ev.name || "");

  // ---- Predictions: call a show's World Class finish before scores post ----
  // Guesses live in localStorage (survive refresh, close, restart — per
  // device, like favorites), keyed by date|name. Scored automatically the
  // moment the show's results land.
  const PREDS = (() => {
    let m;
    try { m = JSON.parse(localStorage.getItem(NS("cad-preds")) || "{}"); }
    catch (e) { m = {}; }
    const save = () => { try { localStorage.setItem(NS("cad-preds"), JSON.stringify(m)); } catch (e) {} };
    return {
      get: k => m[k] || null,
      set: (k, order) => { m[k] = { order, ts: Date.now() }; save(); },
      del: k => { delete m[k]; save(); },
      all: () => m,
    };
  })();
  // World Class finish order (corps, best→worst) from a scored event, else []
  function wcOrder(ev) {
    const wc = (ev.classes || []).find(c => c.class === "World Class");
    if (!wc || !(wc.results || []).length) return [];
    return wc.results.slice().sort((a, b) => (a.place || 99) - (b.place || 99)).map(r => r.corps);
  }
  function wcScoreMap(ev) {
    const wc = (ev.classes || []).find(c => c.class === "World Class");
    const m = new Map();
    if (wc) (wc.results || []).forEach(r => { if (r.score != null) m.set(r.corps, r.score); });
    return m;
  }
  // grading rules live in docs/lib/season-utils.js (pure + unit-tested)
  const scorePred = window.CadSeasonUtils.scorePred;
  // Render the prediction UI into a mount div: the scored result if the show
  // is in, otherwise the tap-to-rank card (or the locked pick). Self-contained
  // — manages its own re-renders and click handling.
  // the graded result card (head + you-vs-real table), reused inline on the
  // event card and on the My Calls page
  function predResultHtml(order, actual, scores) {
    const s = scorePred(order, actual);
    const apos = new Map(actual.map((c, i) => [c, i]));
    // side by side: at each finishing spot, the corps YOU put there and the
    // corps that ACTUALLY landed there (with its final score) — so the guess
    // and the result read straight across. Row tints green when they match
    // (exact), amber when your pick was one spot off.
    const rows = order.map((corps, i) => {
      const ap = apos.get(corps);
      const d = ap == null ? null : Math.abs(ap - i);
      const st = d === 0 ? "hit" : d === 1 ? "near" : "miss";
      const real = actual[i];
      const tick = d === 0 ? ' <span class="pr-tick">✓</span>' : "";
      const sv = real && scores && scores.get(real) != null ? `<div class="pr-score">${score3(scores.get(real))}</div>` : "";
      return `<tr class="pr-${st}"><td class="num">${i + 1}</td>`
        + `<td class="pr-you">${corpsLink(corps)}${tick}</td>`
        + `<td class="pr-real">${real ? corpsLink(real) + sv : "—"}</td></tr>`;
    }).join("");
    return h`<div class="pr-head">${TARGET_SVG} Your call: <b>${s.pct}%</b> <span class="kicker">${s.exact}/${s.n} exact · ${s.pts}/${s.max} pts</span></div>
      <table class="t pr-table"><thead><tr><th class="num">#</th><th>Your pick</th><th>Actual finish</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function mountPredict(container, ev, wcCorps, wcRank) {
    const key = pinKeyOf(ev);
    const actual = wcOrder(ev);
    const pred = PREDS.get(key);

    if (actual.length) {                       // show is scored → grade the call
      if (!pred) { container.innerHTML = ""; return; }
      container.innerHTML = `<div class="predict done">${predResultHtml(pred.order, actual, wcScoreMap(ev))}</div>`;
      return;
    }

    if (!ev.future) { container.innerHTML = ""; return; }
    let lineup = (ev.lineup || []).filter(c => wcCorps.has(c));
    if (lineup.length < 2) lineup = (ev.lineup || []).slice();   // early-season fallback
    if (lineup.length < 2) {
      container.innerHTML = `<div class="predict"><div class="pr-head">${TARGET_SVG} Call the finish</div>`
        + `<div class="pr-empty">Opens once the lineup is posted.</div></div>`;
      return;
    }

    let draft = pred ? pred.order.filter(c => lineup.includes(c)) : [];
    let locked = !!pred;
    const draw = () => {
      const rest = lineup.filter(c => !draft.includes(c));
      if (locked) {
        container.innerHTML = h`<div class="predict">
          <div class="pr-head">${TARGET_SVG} Your call is in <span class="kicker">edit anytime until scores post</span></div>
          <ol class="pr-list locked">${draft.map(c => `<li>${corpsLink(c)}</li>`).join("")}</ol>
          <div class="pr-actions"><button class="tab" data-act="edit">Edit pick</button></div></div>`;
      } else {
        container.innerHTML = h`<div class="predict">
          <div class="pr-head">${TARGET_SVG} Call the finish <span class="kicker">tap them in the order you think they'll place</span></div>
          <ol class="pr-list">${draft.map((c, i) => `<li><button class="pr-pick" data-drop="${i}">${esc(c)}<span class="pr-x">✕</span></button></li>`).join("")
            || '<li class="pr-hint">Tap ' + TERM.a + ' below to start ranking…</li>'}</ol>
          ${rest.length ? `<div class="pr-pool">${rest.map(c => `<button class="pr-chip" data-add="${esc(c)}">${esc(c)}</button>`).join("")}</div>` : ""}
          <div class="pr-actions">
            ${rest.length ? `<button class="tab" data-act="auto">Auto-fill rest</button>` : ""}
            ${draft.length ? `<button class="tab" data-act="reset">Reset</button>` : ""}
            ${draft.length >= 2 ? `<button class="tab pr-lock" data-act="lock">Lock it in ✓</button>` : ""}
          </div></div>`;
      }
    };
    container.onclick = e => {
      const add = e.target.closest("[data-add]"), drop = e.target.closest("[data-drop]"), act = e.target.closest("[data-act]");
      if (add) { draft.push(add.dataset.add); draw(); return; }
      if (drop) { draft.splice(+drop.dataset.drop, 1); draw(); return; }
      if (!act) return;
      const a = act.dataset.act;
      if (a === "reset") draft = [];
      else if (a === "auto") lineup.filter(c => !draft.includes(c))
        .sort((x, y) => (wcRank[x] ?? 999) - (wcRank[y] ?? 999)).forEach(c => draft.push(c));
      else if (a === "lock") { PREDS.set(key, draft); locked = true; }
      else if (a === "edit") locked = false;
      draw();
    };
    draw();
  }

  // "My Calls" — every prediction you've made: graded ones (with the
  // right/wrong breakdown) and pending ones awaiting results.
  async function viewPredictions(_m, stale) {
    setNav("events");
    const all = PREDS.all();
    const keys = Object.keys(all);
    app.innerHTML = h`<div class="crumbs"><a href="#/events">Shows</a> / My Calls</div>
      <h1 class="page">My Calls</h1>`;
    if (!keys.length) {
      app.innerHTML += `<div class="card"><div class="empty">You haven't called a show yet — open an upcoming show in <a href="#/events">Shows</a> and tap “Call the finish.”</div></div>`;
      return;
    }
    // pull the seasons we need to grade against, plus upcoming for pending shows
    const years = [...new Set(keys.map(k => (k.slice(0, 4))).filter(y => /^\d{4}$/.test(y)))];
    const byKey = new Map();
    for (const y of years) {
      try {
        const evs = await data(`seasons/${y}.json`);
        if (stale()) return;
        evs.forEach(ev => byKey.set(pinKeyOf(ev), ev));
      } catch (e) { /* season not built */ }
    }
    try {
      const up = await data("upcoming.json");
      if (stale()) return;
      up.forEach(u => {
        const k = (u.date || "") + "|" + (u.name || "");
        if (!byKey.has(k)) byKey.set(k, { name: u.name, date: u.date, location: u.location, future: true });
      });
    } catch (e) { /* no upcoming */ }

    const graded = [], pending = [];
    for (const k of keys) {
      const pred = all[k];
      const date = k.slice(0, 10);
      const name = k.slice(k.indexOf("|") + 1);
      const ev = byKey.get(k);
      const actual = ev ? wcOrder(ev) : [];
      if (actual.length) graded.push({ date, name, pred, actual, scores: wcScoreMap(ev), s: scorePred(pred.order, actual) });
      else pending.push({ date, name, pred, ev });
    }
    graded.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    pending.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

    const avg = graded.length ? Math.round(graded.reduce((s, g) => s + g.s.pct, 0) / graded.length) : 0;
    const best = graded.length ? Math.max(...graded.map(g => g.s.pct)) : 0;
    const exactTot = graded.reduce((s, g) => s + g.s.exact, 0);

    const statCard = graded.length ? h`<div class="card prstats">
      <div class="prstat"><div class="prstat-n">${graded.length}</div><div class="prstat-l">graded</div></div>
      <div class="prstat"><div class="prstat-n">${avg}%</div><div class="prstat-l">avg</div></div>
      <div class="prstat"><div class="prstat-n">${best}%</div><div class="prstat-l">best</div></div>
      <div class="prstat"><div class="prstat-n">${exactTot}</div><div class="prstat-l">exact hits</div></div>
    </div>` : "";

    // most recent graded call opens expanded so you land on your latest result
    const gradedHtml = graded.map((g, i) => h`
      <div class="prcall${i === 0 ? " open" : ""}">
        <button class="prcall-head" data-toggle="${i}">
          <span class="prcall-date">${esc(fmtDateY(g.date) || g.date)}</span>
          <span class="prcall-name">${esc(g.name)}</span>
          <span class="prcall-pct">${g.s.pct}%</span>
        </button>
        <div class="prcall-body"${i === 0 ? "" : " hidden"}>${predResultHtml(g.pred.order, g.actual, g.scores)}</div>
      </div>`).join("");

    const pendingHtml = pending.length ? h`
      <h2 class="prsec">Awaiting results</h2>
      ${pending.map(pn => h`<div class="prcall pending">
        <div class="prcall-head static">
          <span class="prcall-date">${esc(fmtDateY(pn.date) || pn.date)}</span>
          <span class="prcall-name">${esc(pn.name)}</span>
          <span class="prcall-pct muted">${pn.pred.order.length} ranked</span>
        </div></div>`).join("")}` : "";

    app.innerHTML += h`${statCard}
      ${graded.length ? `<h2 class="prsec">Your calls</h2>${gradedHtml}` : ""}
      ${pendingHtml}`;

    app.querySelectorAll(".prcall-head[data-toggle]").forEach(btn => {
      btn.addEventListener("click", () => {
        const body = btn.nextElementSibling;
        body.hidden = !body.hidden;
        btn.parentElement.classList.toggle("open", !body.hidden);
      });
    });
  }

  function setNav(route) {
    document.querySelectorAll("#nav a").forEach(a =>
      a.classList.toggle("active", a.dataset.route === route));
  }
  // Collapse long tables to the first `n` rows with a Show-all toggle.
  // Safe to call again after a re-render (replaces its own button).
  function collapseRows(tbody, n, noun) {
    const host = tbody.closest(".tscroll") || tbody.closest("table").parentElement;
    const old = host.nextElementSibling;
    if (old && old.classList && old.classList.contains("expandwrap")) old.remove();
    const rows = [...tbody.rows];
    if (rows.length <= n + 3) return;
    let open = false;
    // when collapsed, keep any starred favorite visible in its real position so
    // it's still easy to find (other overflow rows hide as usual)
    const applyRows = () => rows.slice(n).forEach(r => r.classList.toggle("hid", !open && !r.classList.contains("favrow")));
    const wrap = document.createElement("div");
    wrap.className = "expandwrap";
    const btn = document.createElement("button");
    btn.className = "tab";
    btn.onclick = () => {
      open = !open;
      applyRows();
      btn.textContent = open ? `Show top ${n} ▴` : `Show all ${rows.length} ${noun} ▾`;
      // collapsing from deep in a long table: bring the table top back on screen
      if (!open && host.getBoundingClientRect().top < 0) host.scrollIntoView({ block: "start" });
    };
    btn.textContent = `Show all ${rows.length} ${noun} ▾`;
    wrap.appendChild(btn);
    host.insertAdjacentElement("afterend", wrap);
    applyRows();
  }

  const CAP_KEY_NOTE = "<p class='capkey'>GE General Effect · VP Visual Proficiency · VA Visual Analysis · CG Color Guard · BR Brass · MA Music Analysis · PC Percussion</p>";

  // underline sub-tabs inside the Data tab (Stats)
  const DATA_SUBS = (CAPS ? [["captions", "Captions"]] : []).concat([["compare", "Compare"], ["champions", "Champions"], ["records", "Records"], ["database", "Database"]]);
  // the strip scrolls horizontally on a narrow screen; once the view's
  // innerHTML lands, nudge the active view into view so landing on "Database"
  // (the rightmost tab) never leaves it clipped off the right edge
  function centerSubtab() {
    const strip = app.querySelector(".subtabs");
    const on = strip && strip.querySelector("a.on");
    if (!strip || !on) return;
    const sr = strip.getBoundingClientRect(), ar = on.getBoundingClientRect();
    strip.scrollLeft += (ar.left - sr.left) - (sr.width - ar.width) / 2;
  }
  const dataSubNav = active => {
    requestAnimationFrame(centerSubtab);
    return `<div class="subtabs">${DATA_SUBS.map(([k, l]) =>
      `<a href="#/${k}" class="${k === active ? "on" : ""}">${l}</a>`).join("")}</div>`;
  };

  // one-choice slicer with the same look as the checkbox pickers
  function singleSelect(mount, cfg) {
    const selected = new Set(cfg.value != null ? [String(cfg.value)] : []);
    const ms = multiSelect(mount, {
      label: cfg.label || "", single: true, searchable: cfg.searchable, searchHint: cfg.searchHint,
      options: cfg.options, selected,
      onChange: v => cfg.onChange(v[0]),
    });
    return {
      get: () => [...selected][0],
      set: v => { selected.clear(); if (v != null) selected.add(String(v)); ms.refresh(); },
      setOptions: opts => ms.setOptions(opts),
      refresh: () => ms.refresh(),
    };
  }

  const CLASS_ORDER = FAM ? FAM.classOrder : ["World Class", "Open Class", "All-Age", "International"];
  const sortClasses = names => names.sort((a, b) => {
    const ia = CLASS_ORDER.indexOf(a), ib = CLASS_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const COMBINABLE_SCORE_CLASSES = new Set(FAM ? (FAM.combinable || []) : ["World Class", "Open Class"]);

  /* Each class's standings are built independently, so a corps' row only knows
     that class's history. Corps routinely cross classes in one season (Open
     Class corps run World Class prelims at Championships), which left their row
     reading "—" for vs-prev, a season high equal to that single score, and an
     empty sparkline. Stitch every class's history for a corps together so the
     delta, 3-show average, season high and trend describe their ACTUAL season —
     while the row itself (score, date, event, ranking) stays true to the class
     being shown. */
  const stitchSeasonHistory = window.CadSeasonUtils.stitchSeasonHistory;

  function combinedStandings(standings, selected) {
    // one row per corps: their most recent result across the selected classes,
    // so a corps that ran two classes never appears twice
    const groups = new Map();
    selected.forEach(cls => (standings[cls].rows || []).forEach(r => {
      const g = groups.get(r.corps) || [];
      g.push({ ...r, class: cls });
      groups.set(r.corps, g);
    }));
    const picked = [...groups.values()].map(g => g.length === 1 ? g[0]
      : g.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "")
        || (b.score ?? -Infinity) - (a.score ?? -Infinity))[0]);
    const rows = stitchSeasonHistory(standings, picked)
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.corps.localeCompare(b.corps))
      .map((r, i) => ({ ...r, rank: i + 1 }));
    const movers = rows.filter(r => Number.isFinite(r.delta))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.rank - b.rank).slice(0, 3);
    const battles = rows.slice(1).map((r, i) => {
      const prev = rows[i];
      return { a: prev.corps, b: r.corps, ra: prev.rank, rb: r.rank,
        sa: prev.score, sb: r.score, gap: +Math.abs(prev.score - r.score).toFixed(3) };
    }).sort((a, b) => a.gap - b.gap || a.ra - b.ra);
    return { rows, movers, battles };
  }

  /* ============ multiselect dropdown ============ */
  // Document-level listeners: outside click / Escape close any open panel.
  function closeMsels() {
    document.querySelectorAll(".msel.open").forEach(ms => {
      ms.classList.remove("open");
      const b = ms.querySelector(".msel-btn");
      if (b) b.setAttribute("aria-expanded", "false");
    });
  }
  document.addEventListener("click", e => {
    document.querySelectorAll(".msel.open").forEach(ms => {
      if (!ms.contains(e.target)) {
        ms.classList.remove("open");
        const b = ms.querySelector(".msel-btn");
        if (b) b.setAttribute("aria-expanded", "false");
      }
    });
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeMsels(); });

  function multiSelect(mount, cfg) {
    // cfg: {label, options:[{value,label,hint?}], selected:Set<string>, onChange, searchable?}
    mount.classList.add("msel");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctrl msel-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    const panel = document.createElement("div");
    panel.className = "msel-panel";
    panel.setAttribute("role", "listbox");
    let q = "";

    function summary() {
      // a view can name well-known selections ("Top 12"); null falls through
      if (cfg.summary) {
        const s = cfg.summary();
        if (s != null) return s;
      }
      const n = cfg.selected.size;
      if (!n) return cfg.label;
      const lbls = [...cfg.selected].map(v =>
        (cfg.options.find(o => String(o.value) === String(v)) ||
          { label: cfg.labelFor ? cfg.labelFor(v) : v }).label);
      return n <= 2 ? lbls.join(", ") : `${lbls[0]}, ${lbls[1]} +${n - 2}`;
    }
    function renderBtn() {
      btn.innerHTML = `<span class="msel-sum">${esc(summary())}</span><span class="msel-caret">▾</span>`;
    }
    function renderPanel() {
      panel.innerHTML = "";
      if (cfg.bulk) {
        const bar = document.createElement("div");
        bar.className = "msel-bulk";
        const mk = (txt, fn) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "msel-bulk-btn";
          b.textContent = txt;
          b.onclick = e => {
            e.stopPropagation();
            fn();
            renderBtn();
            renderPanel();
            cfg.onChange([...cfg.selected]);
          };
          return b;
        };
        if (cfg.bulkAll !== false) bar.appendChild(mk("Select all", () => cfg.options.forEach(o => cfg.selected.add(String(o.value)))));
        (cfg.presets || []).forEach(p => bar.appendChild(mk(p.label, () => {
          cfg.selected.clear();
          p.values().forEach(v => cfg.selected.add(String(v)));
        })));
        bar.appendChild(mk("None", () => cfg.selected.clear()));
        panel.appendChild(bar);
      }
      if (cfg.searchable) {
        const inp = document.createElement("input");
        inp.className = "ctrl msel-search";
        inp.placeholder = "Search…";
        inp.value = q;
        inp.oninput = () => { q = inp.value.toLowerCase(); renderList(); };
        inp.onclick = e => e.stopPropagation();
        panel.appendChild(inp);
        // don't auto-focus on touch devices — focusing pops the keyboard
        if (!matchMedia("(pointer: coarse)").matches) setTimeout(() => inp.focus(), 0);
      }
      const list = document.createElement("div");
      list.className = "msel-list";
      panel.appendChild(list);

      function renderList() {
        list.innerHTML = "";
        const opts = cfg.options.filter(o => !q || o.label.toLowerCase().includes(q) || (cfg.searchHint && (o.hint || "").toLowerCase().includes(q)));
        if (!opts.length) list.innerHTML = "<div class='empty' style='padding:10px'>No matches</div>";
        opts.forEach(o => {
          const row = document.createElement("label");
          row.className = `msel-opt${o.exclusive ? " exclusive" : ""}`;
          const cb = document.createElement("input");
          cb.type = o.exclusive ? "radio" : "checkbox";
          if (o.exclusive) cb.name = `${mount.id || "msel"}-exclusive`;
          cb.checked = cfg.selected.has(String(o.value));
          cb.onchange = () => {
            const k = String(o.value);
            if (cfg.single) {
              cfg.selected.clear();
              cfg.selected.add(k);
              closeMsels();
            } else {
              cb.checked ? cfg.selected.add(k) : cfg.selected.delete(k);
            }
            renderBtn();
            cfg.onChange([...cfg.selected]);
          };
          row.appendChild(cb);
          const sp = document.createElement("span");
          sp.textContent = o.label;
          row.appendChild(sp);
          if (o.hint) {
            const ht = document.createElement("span");
            ht.className = "hint";
            ht.textContent = o.hint;
            row.appendChild(ht);
          }
          row.onclick = e => e.stopPropagation();
          list.appendChild(row);
        });
      }
      renderList();
    }
    btn.onclick = e => {
      e.stopPropagation();
      const open = mount.classList.contains("open");
      closeMsels();
      if (!open) {
        mount.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
        q = "";
        renderPanel();
      }
    };
    renderBtn();
    mount.append(btn, panel);
    return {
      refresh: renderBtn,
      setOptions: opts => {
        cfg.options = opts;
        renderBtn();
        if (mount.classList.contains("open")) renderPanel();
      },
    };
  }

  /* ===== "Following" strip — the starred corps, pinned atop the Scoreboard.
     Compact by design: one row per favorite with the facts a fan checks first
     (rank, latest score and movement, LIVE state, next show when one is
     verified). Never duplicates the standings table below it. */
  const ord = n => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const followSeen = {
    read() { try { return JSON.parse(localStorage.getItem("cad-follow-seen") || "{}") || {}; } catch (e) { return {}; } },
    write(m) { try { localStorage.setItem("cad-follow-seen", JSON.stringify(m)); } catch (e) {} },
  };
  async function renderFollowStrip(mount, rk) {
    if (!mount) return;
    const favs = FAVS.list();
    if (!favs.length) {
      // onboarding was skipped — one quiet, dismissible pointer, never a big card
      let dismissed = true;
      try { dismissed = !!localStorage.getItem("cad-follow-hint") || localStorage.getItem("cad-onboard") !== "1"; } catch (e) {}
      mount.innerHTML = dismissed ? "" : `
        <div class="folhint">★ Star a corps to pin it here —
          <button type="button" class="linklike" id="folPick">choose favorites</button>
          <button type="button" class="folhint-x" aria-label="Dismiss">×</button></div>`;
      const pick = mount.querySelector("#folPick");
      if (pick) pick.onclick = () => CadOnboard.open(true);
      const x = mount.querySelector(".folhint-x");
      if (x) x.onclick = () => { try { localStorage.setItem("cad-follow-hint", "1"); } catch (e) {} mount.innerHTML = ""; };
      return;
    }
    // latest row per favorite across every class (a corps that moved between
    // classes keeps its most recent result)
    const rows = new Map();
    for (const [cls, block] of Object.entries(rk.standings || {})) {
      for (const r of block.rows || []) {
        if (!favs.includes(r.corps)) continue;
        const prev = rows.get(r.corps);
        if (!prev || (r.date || "") > (prev.date || "")) rows.set(r.corps, { ...r, cls });
      }
    }
    // next verified appearance, when the upcoming feed has one (off-season:
    // usually nothing — the line simply doesn't render; never fabricated)
    let nexts = new Map();
    try {
      const up = await data("upcoming.json");
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
      for (const name of favs) {
        const ev = (up || []).find(e => (e.date || "") >= today && !e.kind
          && ((e.lineup || []).includes(name) || e.corps === name));
        if (ev) nexts.set(name, ev);
      }
    } catch (e) {}
    const seen = followSeen.read();
    let seeded = false;
    const cards = favs.map(name => {
      const r = rows.get(name);
      if (!r) {
        return `<a class="fol-card" href="#/corps/${slugOf(name)}">${corpsLogo(name, 30)}
          <span class="fol-main"><b>${esc(name)}</b>
          <span class="fol-sub">No ${esc(String(rk.season))} scores yet</span></span></a>`;
      }
      const cur = `${r.date}|${r.score}`;
      let isNew = false;
      if (seen[name] == null) { seen[name] = cur; seeded = true; }        // first sight: seed silently
      else if (seen[name] !== cur) isNew = true;
      const live = LIVE.corpsLive(r.corps);
      const nx = nexts.get(name);
      const rankBit = r.rank ? `${ord(r.rank)} · ${esc(r.cls.replace(" Class", ""))}` : esc(r.cls);
      return `<a class="fol-card" href="#/corps/${slugOf(name)}" data-fol="${esc(name)}" data-cur="${esc(cur)}">
        ${corpsLogo(name, 30)}
        <span class="fol-main">
          <span class="fol-top"><b>${esc(name)}</b>${live ? " " + LIVE_BADGE : ""}${isNew ? ' <span class="fol-new">New score</span>' : ""}<span class="fol-rank">${rankBit}</span></span>
          <span class="fol-sub">${score3(r.score)}${r.delta != null ? " " + deltaHtml(r.delta) : ""} · ${esc(fmtDate(r.date))} · ${esc(r.event || "")}</span>
          ${nx ? `<span class="fol-sub fol-next">Next · ${esc(fmtDate(nx.date))} — ${esc(nx.name || "")}</span>` : ""}
        </span></a>`;
    });
    if (seeded) followSeen.write(seen);
    mount.innerHTML = `<div class="folwrap"><div class="folhead">Following</div>
      <div class="folgrid">${cards.join("")}</div></div>`;
    mount.querySelectorAll("[data-fol]").forEach(a => a.addEventListener("click", () => {
      const m = followSeen.read();
      m[a.dataset.fol] = a.dataset.cur;
      followSeen.write(m);
    }));
  }

  const daysSinceLastScore = rk => window.CadSeasonUtils.daysSinceLastScore(rk, Date.now());

  /* ===== off-season home module: a truthful next-season countdown.
     Renders only between seasons, and only once a real future show is in the
     verified upcoming feed. (The "This Day in DCI History" panel is retired
     for now — its onthisday index is still built, so it can return later.) */
  async function renderOffseasonHome(mount, rk) {
    if (!mount) return;
    if (daysSinceLastScore(rk) <= 7) { mount.innerHTML = ""; return; }
    const etNow = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    let next = null;
    try {
      const up = await data("upcoming.json");
      next = (up || []).filter(e => !e.kind && (e.date || "") >= etNow)
        .sort((a, b) => (a.date || "").localeCompare(b.date || ""))[0] || null;
    } catch (e) {}
    if (!next) { mount.innerHTML = ""; return; }
    const days = Math.max(0, Math.ceil((new Date(next.date + "T12:00:00") - Date.now()) / 86400000));
    const nextLine = `Next season starts <b>${esc(fmtDateY(next.date))}</b> — ${esc(next.name || "")}${days ? ` · in ${days} day${days === 1 ? "" : "s"}` : " · today"}`;
    mount.innerHTML = `
      <div class="card offszn">
        <p class="offnext">${nextLine}</p>
      </div>`;
  }

  /* ===== season picker — the year in the Scoreboard heading IS the control.
     A grid of years beats a 53-item dropdown: every season is one tap, and
     the reader can see the whole span of the archive at once. */
  const CHEVRON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  // the tappable, gold-underlined season control — reused verbatim by the
  // Scoreboard heading and the Shows heading so both switch years the same way
  function yearPickerHtml(year) {
    return `<span class="yearwrap" id="yearWrap">`
      + `<button type="button" class="yearpick" aria-haspopup="listbox" aria-expanded="false" title="Change season">${esc(String(year))}${CHEVRON_SVG}</button>`
      + `<div class="yearpanel" role="listbox" aria-label="Season" hidden></div>`
      + `</span>`;
  }
  function yearHeaderHtml(year) {
    return `<h1 class="page">${yearPickerHtml(year)} Scoreboard</h1>`;
  }
  function wireYearPicker(years, value, onPick) {
    const wrap = document.getElementById("yearWrap");
    if (!wrap) return;
    const btn = wrap.querySelector(".yearpick");
    const panel = wrap.querySelector(".yearpanel");
    let open = false, built = false;
    const onDown = e => {
      // a route change can swap the whole view out from under an open panel;
      // drop the listener rather than acting on a detached node
      if (!wrap.isConnected) { document.removeEventListener("pointerdown", onDown, true); return; }
      if (!wrap.contains(e.target)) setOpen(false);
    };
    function setOpen(v) {
      // built on first open: the heading keeps a clean text content, and the
      // common case (never touching the picker) never builds 53 buttons
      if (v && !built) {
        // tabindex="-1": the grid is walked with arrows (below), so 53 seasons
        // never become 53 tab stops between the heading and the board
        panel.innerHTML = years.map(y =>
          `<button type="button" role="option" tabindex="-1" class="yearopt${y === value ? " on" : ""}" data-y="${y}" aria-selected="${y === value}">${y}</button>`).join("");
        built = true;
      }
      open = v;
      panel.hidden = !v;
      wrap.classList.toggle("open", v);
      btn.setAttribute("aria-expanded", v ? "true" : "false");
      if (!v) { document.removeEventListener("pointerdown", onDown, true); return; }
      document.addEventListener("pointerdown", onDown, true);
      const cur = panel.querySelector(".yearopt.on") || panel.firstElementChild;
      if (cur) {
        // scroll the panel itself — never the page out from under the reader
        panel.scrollTop = Math.max(0, cur.offsetTop - panel.clientHeight / 2 + cur.offsetHeight / 2);
        cur.focus({ preventScroll: true });
      }
    }
    btn.onclick = () => setOpen(!open);
    panel.onclick = e => {
      const opt = e.target.closest("[data-y]");
      if (!opt) return;
      setOpen(false);
      btn.focus();
      onPick(+opt.dataset.y);
    };
    wrap.addEventListener("keydown", e => {
      if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); btn.focus(); return; }
      if (!open) return;
      // Tab closes and hands focus back to the trigger, so the panel can never
      // trap keyboard users or linger open behind them
      if (e.key === "Tab") { e.preventDefault(); setOpen(false); btn.focus(); return; }
      // arrow/Home/End walk the grid — 53 seasons is far too many to Tab through
      const nav = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 0, ArrowUp: 0, Home: 0, End: 0 };
      if (!(e.key in nav)) return;
      const opts = [...panel.querySelectorAll(".yearopt")];
      const i = opts.indexOf(document.activeElement);
      if (i < 0) return;
      const cols = getComputedStyle(panel).gridTemplateColumns.split(/\s+/).filter(Boolean).length || 4;
      let n = e.key === "Home" ? 0
        : e.key === "End" ? opts.length - 1
        : e.key === "ArrowDown" ? i + cols
        : e.key === "ArrowUp" ? i - cols
        : i + nav[e.key];
      if (n < 0 || n >= opts.length || n === i) return;
      e.preventDefault();
      const el = opts[n];
      el.focus({ preventScroll: true });
      if (el.offsetTop < panel.scrollTop) panel.scrollTop = el.offsetTop - 8;
      else if (el.offsetTop + el.offsetHeight > panel.scrollTop + panel.clientHeight)
        panel.scrollTop = el.offsetTop + el.offsetHeight - panel.clientHeight + 8;
    });
  }

  /* A season's own archive occasionally holds one stray event months away
     from the tour — 2007's World Class block, for instance, includes an
     indoor mini-corps contest in March, 91 days before the first real show.
     Plotted literally, that lone point stretches the axis across an empty
     quarter of the year and squashes the actual season into a corner.

     So squeeze any stretch of EMPTY calendar wider than TREND_MAX_GAP down
     to that width, mapping dates through a piecewise-linear scale. Every
     point still appears, in date order, and tick labels stay truthful
     because the chart formats them back through the inverse. Returns null
     when nothing needs squeezing, which is the normal case. */
  const TREND_MAX_GAP = 12;   // days of empty axis worth showing at most
  function compressTrendGaps(series, maxGap) {
    const gapMax = maxGap || TREND_MAX_GAP;
    const xs = [...new Set(series.flatMap(s => s.points.map(p => p.x)))].sort((a, b) => a - b);
    if (xs.length < 2) return null;
    const segs = [];
    let v = xs[0], squeezed = false;
    for (let i = 1; i < xs.length; i++) {
      const x0 = xs[i - 1], x1 = xs[i], gap = x1 - x0;
      const w = gap > gapMax ? gapMax : gap;
      if (gap > gapMax) squeezed = true;
      segs.push({ x0, x1, v0: v, v1: v + w });
      v += w;
    }
    if (!squeezed) return null;
    const first = segs[0], last = segs[segs.length - 1];
    const fwd = x => {
      if (x <= first.x0) return first.v0 + (x - first.x0);
      for (const s of segs) if (x <= s.x1) return s.v0 + (x - s.x0) / (s.x1 - s.x0) * (s.v1 - s.v0);
      return last.v1 + (x - last.x1);
    };
    const back = t => {
      if (t <= first.v0) return first.x0 + (t - first.v0);
      for (const s of segs) if (t <= s.v1) return s.x0 + (t - s.v0) / (s.v1 - s.v0) * (s.x1 - s.x0);
      return last.x1 + (t - last.v1);
    };
    return {
      series: series.map(s => ({ ...s, points: s.points.map(p => ({ ...p, x: fwd(p.x) })) })),
      fwd,
      xFmt: t => dayLabel(back(t)),
    };
  }

  /* ============ RANKINGS (home) ============ */
  // archived boards are pure functions of a season file, and the class filter
  // re-renders the view — memoise so toggling a class on 1972 (211 events,
  // 322 corps) doesn't rebuild the whole season each time
  const archiveBoards = new Map();
  const archiveClassPick = new Map();   // year -> classes picked, this visit only

  /* ---- year-range prose for the gaps in a championship record ---- */
  function champGapNote(years) {
    if (years.length < 2) return "";
    const have = new Set(years), miss = [];
    for (let y = Math.min(...years); y <= Math.max(...years); y++) if (!have.has(y)) miss.push(y);
    if (!miss.length) return "";
    const runs = [];
    miss.forEach(y => {
      const last = runs[runs.length - 1];
      if (last && y === last[1] + 1) last[1] = y; else runs.push([y, y]);
    });
    return "no championships " + runs.map(r => r[0] === r[1] ? String(r[0])
      : `${r[0]}–${String(r[1]).slice(-2)}`).join(", ");
  }

  async function champBoard(qs, stale, rk) {
    const winners = rk.winners || {};
    const classes = sortClasses(Object.keys(winners).filter(c => (winners[c] || []).length));
    const allYears = [...new Set(classes.flatMap(c => winners[c].map(w => +w[0])))].sort((a, b) => b - a);
    if (!classes.length || !allYears.length) {
      app.innerHTML = `<h1 class="page">Championships</h1>${noteHtml("board")}`
        + `<div class="card"><div class="empty">The championship record builds with the next data run.</div></div>`;
      return;
    }
    await ensureLogos();
    if (stale()) return;
    const latest = allYears.includes(+rk.season) ? +rk.season : allYears[0];
    const asked = +parseHashQuery(qs).y;
    const year = allYears.includes(asked) ? asked : latest;
    const gapNote = champGapNote(allYears);

    // which classes the chart draws — remembered per app, like the DCI board's
    // class picker. Never empty: clearing it falls back to every class.
    let saved = [];
    try {
      const s = JSON.parse(localStorage.getItem(NS("dt-champcls")) || "[]");
      if (Array.isArray(s)) saved = s.filter(c => classes.includes(c));
    } catch (e) {}
    const chartSet = new Set(saved.length ? saved : classes);

    app.innerHTML = h`
      <h1 class="page">${yearPickerHtml(year)} Championships</h1>
      ${noteHtml("board")}
      <div class="rk-grid">
        <div class="card rk-trend">
          <h2>Winning Score by Season <span class="sub keep" id="champChartSub"></span></h2>
          <div class="filters" style="margin:2px 0 8px"><div id="champClsSel"></div></div>
          <div class="chartwrap" id="champChart"></div>
        </div>
        <div class="card rk-stand">
          <h2 id="champStandTitle"></h2>
          <div id="champStandings"></div>
        </div>
        <div class="card rk-move" id="champMove"></div>
        <div class="card rk-battle" id="champDyn"></div>
      </div>`;
    wireYearPicker(allYears, year, y => { location.hash = y === latest ? "#/" : `#/?y=${y}`; });

    /* ---- the standings: this season's championships, one row per class ---- */
    const rows = classes.map(cls => {
      const w = (winners[cls] || []).find(x => +x[0] === year);
      if (!w) return null;
      const mine = (winners[cls] || []).filter(x => x[1] === w[1]).map(x => +x[0]).sort((a, b) => a - b);
      const prior = mine.filter(y => y < year);
      return { cls, corps: w[1], score: w[2], nth: mine.filter(y => y <= year).length,
        titles: mine.length, prev: prior.length ? prior[prior.length - 1] : null };
    }).filter(Boolean);
    document.getElementById("champStandTitle").innerHTML =
      `${esc(String(year))} World Championships <span class="sub keep">${rows.length} title${rows.length === 1 ? "" : "s"} awarded`
      + `${FAVS.list().length ? " · your favorites are starred" : ""}</span>`;
    document.getElementById("champStandings").innerHTML = rows.length ? `
      <div class="tscroll"><table class="t standings"><thead><tr><th>Class</th><th>Champion</th>
        <th class="num">Score</th><th class="num m-hide">Title #</th><th class="m-hide">Previously</th></tr></thead><tbody>
      ${rows.map(r => `<tr${FAVS.has(r.corps) ? ' class="favrow"' : ""}>
        <td><span class="pill">${esc(r.cls)}</span></td>
        <td><span class="corpscell">${corpsLogo(r.corps, 26)}<span class="corpscell-body">
          <span class="corpscell-name">${corpsLink(r.corps)}</span></span></span></td>
        <td class="num score">${score3(r.score)}</td>
        <td class="num m-hide" style="color:var(--muted)">${r.nth} of ${r.titles}</td>
        <td class="m-hide" style="color:var(--muted)">${r.prev ? "won " + r.prev : "first title"}</td>
      </tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">No championships on record for ${esc(String(year))}.</div>`;

    /* ---- the chart: every winning score this circuit has published ---- */
    function drawChart() {
      const el = document.getElementById("champChart");
      if (!el) return;
      const picked = sortClasses([...chartSet]);
      const pts = picked.reduce((n, c) => n + winners[c].filter(w => w[2] != null).length, 0);
      document.getElementById("champChartSub").textContent =
        `${pts} title score${pts === 1 ? "" : "s"} · ${allYears[allYears.length - 1]}–${allYears[0]}`
        + (gapNote ? ` · ${gapNote}` : "");
      lineChart(el, {
        linearX: true,
        series: picked.map(cls => ({
          name: cls, color: PALETTE[classes.indexOf(cls) % PALETTE.length],
          points: winners[cls].filter(w => w[2] != null).map(w => ({ x: +w[0], y: w[2] })),
        })),
        height: 340, xFmt: v => String(Math.round(v)), yFmt: v => v.toFixed(1),
      });
    }

    /* ---- biggest move: THIS season's winning score against the previous
           championship in the same class. Not every class is contested every
           year (and none was in 2020–21), so the card names both seasons
           rather than implying they are adjacent. ---- */
    function drawMove() {
      const moves = [];
      classes.filter(c => chartSet.has(c)).forEach(cls => {
        const ws = winners[cls].filter(w => w[2] != null).slice().sort((a, b) => a[0] - b[0]);
        const i = ws.findIndex(w => +w[0] === year);
        if (i < 1) return;
        const now = ws[i], before = ws[i - 1];
        moves.push({ cls, corps: now[1], y1: +before[0], y2: +now[0],
          s1: before[2], s2: now[2], d: +(now[2] - before[2]).toFixed(3) });
      });
      moves.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
      const j = moves[0];
      // the CLASS leads, not the champion: the previous score usually belongs
      // to a different ensemble, and putting this year's winner's name above
      // both numbers read as one ensemble's improvement
      document.getElementById("champMove").innerHTML = j ? h`
        <h2>Biggest Move <span class="sub">winning score vs the previous championship</span></h2>
        <div style="font-size:20px;font-weight:650">${esc(j.cls)}</div>
        <div style="color:var(--text-secondary)">${score3(j.s1)} <span class="kicker">${j.y1}</span> →
          <b>${score3(j.s2)}</b> <span class="kicker">${j.y2}</span> ${deltaHtml(j.d)}</div>
        <div style="margin-top:6px;font-size:13px">Taken by ${corpsLink(j.corps)}</div>
        ${moves.slice(1, 3).map(m => `<div style="font-size:13px;margin-top:6px">${esc(m.cls)} ${deltaHtml(m.d)} <span class="kicker">${esc(m.corps)}</span></div>`).join("")}`
        : `<h2>Biggest Move</h2><div class='empty'>No earlier championship in these classes to measure ${esc(String(year))} against.</div>`;
    }

    /* ---- dynasties: most titles in the charted classes ---- */
    function drawDyn() {
      const picked = new Set(chartSet);
      const by = new Map();
      classes.filter(c => picked.has(c)).forEach(cls => winners[cls].forEach(w => {
        const t = by.get(w[1]) || { corps: w[1], n: 0, last: 0 };
        t.n++; t.last = Math.max(t.last, +w[0]);
        by.set(w[1], t);
      }));
      const top = [...by.values()].sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 4)
        .filter(t => t.n > 1);
      document.getElementById("champDyn").innerHTML = top.length ? `
        <h2>Dynasties <span class="sub">most titles in these classes</span></h2>
        <table class="t">${top.map((t, i) => `<tr${FAVS.has(t.corps) ? ' class="favrow"' : ""}>
          <td class="rank">${i + 1}</td><td>${corpsLink(t.corps)}</td>
          <td class="num score">${t.n}</td><td class="num kicker">${t.last}</td></tr>`).join("")}</table>
        <div style="margin-top:8px;font-size:13px"><a href="#/records">The full record book →</a></div>`
        : "<h2>Dynasties</h2><div class='empty'>Nobody has won these classes twice yet.</div>";
    }

    multiSelect(document.getElementById("champClsSel"), {
      label: "Pick classes to chart…",
      summary: () => chartSet.size === classes.length ? "All classes" : null,
      bulk: true,
      options: classes.map(c => ({ value: c, label: c, hint: `${winners[c].length} titles` })),
      selected: chartSet,
      onChange: () => {
        if (!chartSet.size) classes.forEach(c => chartSet.add(c));
        try { localStorage.setItem(NS("dt-champcls"), JSON.stringify([...chartSet])); } catch (e) {}
        drawChart(); drawMove(); drawDyn();
      },
    });
    drawChart();
    drawMove();
    drawDyn();
  }

  async function viewRankings(qs, stale) {
    setNav("rankings");
    if (FAM) {
      // the dataset says which board it can support: a circuit with no
      // in-season score feed ships kind:"championship" and charts its titles
      const rkc = await data("rankings.json").catch(() => null);
      if (stale()) return;
      if (rkc && rkc.kind === "championship") return champBoard(qs, stale, rkc);
    }
    const meta = await data("meta.json");
    if (stale()) return;
    const years = (meta.seasons || []).map(s => s.year).filter(y => Number.isFinite(y)).sort((a, b) => b - a);
    const latest = years[0] || new Date().getUTCFullYear();
    const asked = +parseHashQuery(qs).y;
    const year = years.includes(asked) ? asked : latest;
    // only the newest season is "live" — past seasons are settled history, so
    // they skip the live-tracking, Following and off-season modules entirely
    const isCurrent = year === latest;
    const header = yearHeaderHtml(year);
    const pickYear = () => wireYearPicker(years, year, y => {
      location.hash = y === latest ? "#/" : `#/?y=${y}`;
    });

    let rk;
    try {
      // the current season reads the pipeline's own rankings.json; past
      // seasons are rebuilt from their events file with the identical
      // algorithm (see CadSeasonUtils.rankingsFromEvents)
      if (isCurrent) rk = await data("rankings.json");
      else {
        if (!archiveBoards.has(year)) {
          archiveBoards.set(year,
            window.CadSeasonUtils.rankingsFromEvents(await data(`seasons/${year}.json`), { season: year }));
        }
        rk = archiveBoards.get(year);
      }
    } catch (e) {
      if (stale()) return;
      app.innerHTML = header
        + `<div class="card"><div class="empty">Couldn't load the ${esc(String(year))} season right now.<br>Pick another season above, or try again in a minute.</div></div>`;
      pickYear();
      return;
    }
    if (stale()) return;
    await ensureLogos();
    if (stale()) return;
    if (isCurrent) { await LIVE.refresh().catch(() => {}); if (stale()) return; }
    // an archived board keeps every class in `standings` so season-stitching
    // sees a corps' whole year, but only offers the rankable ones as boards
    const classes = sortClasses((rk.listClasses || Object.keys(rk.standings || {})).slice());
    if (!classes.length) {
      app.innerHTML = header + `<div class="card"><div class="empty">${isCurrent
        ? `No scores yet for ${esc(String(year))} — check back after the first show.`
        : `No scores on file for ${esc(String(year))}.`}</div></div>`;
      pickYear();
      return;
    }
    const defaults = classes.includes("World Class") ? ["World Class"] : [classes[0]];
    // The current season's class choice is remembered on the device. An
    // archived season's is remembered only for this visit: its class names
    // ("Class B", "All-Girl") are meaningless to the live board and must
    // never overwrite the saved preference — but the choice still has to
    // survive the re-render the picker triggers, hence the in-memory map.
    let saved = [];
    try {
      const src = isCurrent
        ? JSON.parse(localStorage.getItem(NS("dt-classes")) || "[]")
        : archiveClassPick.get(year);
      if (Array.isArray(src)) saved = src.filter(c => classes.includes(c));
    } catch (e) {}
    let selected = sortClasses([...(saved.length ? new Set(saved) : new Set(defaults.length ? defaults : [classes[0]]))]);
    const savedExclusive = selected.find(c => !COMBINABLE_SCORE_CLASSES.has(c));
    if (savedExclusive) selected = [savedExclusive];
    const selectedSet = new Set(selected);
    app.innerHTML = h`
      ${header}
      ${isCurrent ? '<div id="followMount"></div>' : ""}
      <div class="filters"><div id="clsSel"></div></div>
      <div class="rk-grid">
        <div class="card rk-trend">
          <h2 id="trendTitle">Season Progression <span class="sub" id="trendSub">score by date · top 12</span></h2>
          <div class="filters" style="margin:2px 0 8px"><div id="trendCorpsSel"></div><button class="tab" id="trendReset" hidden>Top 12</button><button class="tab" id="trendShare" title="Share this progression as an image">${SHARE_SVG} Share</button></div>
          <div class="chartwrap" id="trendChart"></div>
        </div>
        <div class="card rk-stand">
          <h2 id="standTitle"></h2>
          <div id="standings"></div>
        </div>
        <div class="card rk-move" id="moveCard"></div>
        <div class="card rk-battle" id="battleCard"></div>
      </div>
      ${isCurrent ? '<div id="offSznMount"></div>' : ""}`;

    pickYear();
    if (isCurrent) {
      renderFollowStrip(document.getElementById("followMount"), rk); // async, never blocks the board
      renderOffseasonHome(document.getElementById("offSznMount"), rk);
    }

    const previousSelection = new Set(selected);
    multiSelect(document.getElementById("clsSel"), {
      label: "Class",
      options: classes.map(c => ({ value: c, label: c, hint: `${rk.standings[c].rows.length} ${TERM.plural}`,
        exclusive: !COMBINABLE_SCORE_CLASSES.has(c) })),
      selected: selectedSet,
      summary: () => selectedSet.has("World Class") && selectedSet.has("Open Class")
        ? "World + Open Class" : null,
      onChange: values => {
        const added = values.find(c => !previousSelection.has(c));
        if (added && !COMBINABLE_SCORE_CLASSES.has(added)) {
          selectedSet.clear();
          selectedSet.add(added);
        } else if (added) {
          [...selectedSet].filter(c => !COMBINABLE_SCORE_CLASSES.has(c)).forEach(c => selectedSet.delete(c));
        }
        if (!selectedSet.size) previousSelection.forEach(c => selectedSet.add(c));
        const picked = sortClasses([...selectedSet]);
        if (isCurrent) localStorage.setItem(NS("dt-classes"), JSON.stringify(picked));
        else archiveClassPick.set(year, picked);   // this visit only
        viewRankings(qs, stale);   // re-render, staying on the season being viewed
      },
    });

    selected = sortClasses([...selectedSet]);
    const block = combinedStandings(rk.standings, selected);
    const classLabel = selected.length > 1 ? "World + Open Class" : selected[0];
    const showClassTags = selected.length > 1;

    // progression chart: top 12 pre-selected — open the picker to tweak
    const top12 = block.rows.slice(0, 12).map(r => r.corps);
    const trendPick = new Set(top12);
    const isDefaultPick = () => trendPick.size === top12.length && top12.every(c => trendPick.has(c));
    function drawTrend() {
      const el = document.getElementById("trendChart");
      if (!el) return;
      const rows = block.rows.filter(r => trendPick.has(r.corps));
      document.getElementById("trendSub").textContent =
        isDefaultPick() ? "score by date · top 12" : `score by date · ${rows.length} selected`;
      document.getElementById("trendReset").hidden = isDefaultPick();
      const raw = rows.map(r => ({ name: r.corps, color: corpsColor(r.corps),
        points: r.trend.map(t => ({ x: dayOfSeason(t[0]), y: t[1] })) }));
      const squeeze = compressTrendGaps(raw);
      lineChart(el, {
        linearX: true,
        series: squeeze ? squeeze.series : raw,
        height: 340, xFmt: squeeze ? squeeze.xFmt : dayLabel, yFmt: v => v.toFixed(1),
      });
    }
    const msTrend = multiSelect(document.getElementById("trendCorpsSel"), {
      label: "Pick " + TERM.plural + " to chart…", searchable: block.rows.length > 12,
      summary: () => isDefaultPick() ? "Top 12" : null,
      bulk: true, bulkAll: false,
      presets: [{ label: "Top 12", values: () => top12 }],
      options: block.rows.map(r => ({ value: r.corps, label: r.corps, hint: `#${r.rank}` })),
      selected: trendPick,
      onChange: drawTrend,
    });
    document.getElementById("trendReset").onclick = () => {
      trendPick.clear();
      top12.forEach(c => trendPick.add(c));
      msTrend.refresh();
      drawTrend();
    };
    const trendShareBtn = document.getElementById("trendShare");
    if (trendShareBtn) trendShareBtn.onclick = () => {
      if (!window.CadWrapped || !window.CadWrapped.standingsCard) return;
      // share exactly what's charted right now (the selected corps, in rank order)
      const picked = block.rows.filter(r => trendPick.has(r.corps));
      const src = picked.length ? picked : block.rows;
      // same axis squeeze as the on-screen chart, so a shared card of a
      // season with a stray off-tour date isn't crammed into a corner either
      const squeeze = compressTrendGaps(src.map(r => ({
        points: (r.trend || []).filter(t => t[1] != null).map(t => ({ x: dayOfSeason(t[0]), y: t[1] })) })));
      const mapX = squeeze ? squeeze.fwd : (x => x);
      const rows = src.map(r => ({
        corps: r.corps, color: corpsColor(r.corps), rank: r.rank, last: r.score,
        trend: (r.trend || []).filter(t => t[1] != null).map(t => [mapX(dayOfSeason(t[0])), t[1]]),
      }));
      window.CadWrapped.standingsCard({ year: rk.season, cls: classLabel, rows });
    };
    drawTrend();

    const seasonOver = daysSinceLastScore(rk) > 7;

    function renderStandings() {
      // keep true ranking order — favorites are starred/highlighted in place,
      // not pulled to the top
      const sorted = block.rows.slice().sort((a, b) => a.rank - b.rank);
      // "final scores" implied a championship result, but this board ranks each
      // corps' LAST score — and a handful of archived seasons end with corps at
      // different late-season shows, so the top row isn't always the champion
      document.getElementById("standTitle").innerHTML =
        `${esc(classLabel)} Standings <span class="sub">${seasonOver
          ? `each corps' last score of the ${rk.season} season · your favorites are starred`
          : "each ${TERM.singular}'s most recent score · your favorites are starred"}</span>`;
      document.getElementById("standings").innerHTML = `
        <div class="tscroll"><table class="t standings"><thead><tr><th>#</th><th>Corps · last event</th><th class="num">Score</th><th class="num col-high">3-show avg</th><th class="num col-high">Season high</th><th class="num">vs prev</th><th class="col-trend">Trend</th></tr></thead><tbody>
        ${sorted.map(r => h`<tr${FAVS.has(r.corps) ? ' class="favrow"' : ""}>
          <td class="rank">${r.rank}</td>
          <td><span class="corpscell">${corpsLogo(r.corps, 26)}<span class="corpscell-body"><span class="corpscell-name">${corpsLink(r.corps)}${isCurrent && LIVE.corpsLive(r.corps) ? LIVE_BADGE : ""}${showClassTags ? `<span class="classbadge ${r.class === "Open Class" ? "open" : "world"}" title="${esc(r.class)}">${r.class === "Open Class" ? "Open" : "World"}</span>` : ""}</span><div class="lastev">${esc(fmtDateY(r.date))} · ${esc(r.event)}</div></span></span></td>
          <td class="num score">${score3(r.score)}</td>
          <td class="num col-high" data-tip="${r.trend.length === 1 ? "Their only scored show this season"
            : `Average of the last ${Math.min(3, r.trend.length)} shows — smooths out one judging panel`}">${score3(r.trend.slice(-3).reduce((a, t) => a + t[1], 0) / Math.min(3, r.trend.length))}</td>
          <td class="num col-high" data-tip="${esc(`${score3(r.high)} — ${r.high_event || ""} · ${fmtDateY(r.high_date) || ""}`)}">${score3(r.high)}</td>
          <td class="num">${deltaHtml(r.delta)}</td>
          <td class="col-trend"><span class="sparkcell" data-trend="${r.trend.map(t => t[1]).join(",")}"></span></td>
        </tr>`).join("")}</tbody></table></div>`;
      document.querySelectorAll(".sparkcell").forEach(elm => {
        sparkline(elm, elm.dataset.trend.split(",").map(Number).filter(n => !isNaN(n)), "#97a2b3");
      });
      collapseRows(document.querySelector("#standings tbody"), 5, TERM.plural);
    }
    renderStandings();

    const jump = block.movers && block.movers[0];
    document.getElementById("moveCard").innerHTML = jump ? h`
      <h2>Biggest Move <span class="sub">${seasonOver ? "last show vs previous" : "latest show vs previous"}</span></h2>
      <div style="font-size:20px;font-weight:650">${corpsLink(jump.corps)}</div>
      <div style="color:var(--text-secondary)">${score3(jump.prev_score)} → <b>${score3(jump.score)}</b> ${deltaHtml(jump.delta)}</div>
      ${block.movers.slice(1).map(m => `<div style="font-size:13px;margin-top:6px">${corpsLink(m.corps)} ${deltaHtml(m.delta)}</div>`).join("")}
      <div style="margin-top:10px;font-size:13px"><a href="#/corps/${slugOf(jump.corps)}">Their full season →</a></div>`
      : "<h2>Biggest Move</h2><div class='empty'>Needs two shows.</div>";

    const b = block.battles && block.battles[0];
    document.getElementById("battleCard").innerHTML = b ? h`
      <h2>Closest Battle <span class="sub">smallest gap in standings</span></h2>
      <table class="t">
        <tr><td class="rank">${b.ra}</td><td>${corpsLink(b.a)}</td><td class="num score">${score3(b.sa)}</td></tr>
        <tr><td class="rank">${b.rb}</td><td>${corpsLink(b.b)}</td><td class="num score">${score3(b.sb)}</td></tr>
      </table>
      <div style="margin-top:8px;font-size:13px;color:var(--text-secondary)">Gap: <b style="color:var(--bad)">${b.gap.toFixed(3)}</b></div>
      <div style="margin-top:8px;font-size:13px"><a href="#/compare?c=${slugOf(b.a)},${slugOf(b.b)}&y=${rk.season}">Compare head-to-head →</a></div>`
      : "<h2>Closest Battle</h2><div class='empty'>Needs two " + TERM.plural + " within striking distance.</div>";
  }

  /* ============ CORPS HUB (directory + compare) ============ */
  const YEAR_DASHES = ["", "6 4", "2 4", "9 3 2 3"]; // newest → oldest

  function parseHashQuery(qs) {
    const out = {};
    (qs || "").split("&").forEach(kv => {
      const [k, v] = kv.split("=");
      if (k && v != null) {
        try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = ""; }
      }
    });
    return out;
  }

  // corps "type" = the class it most recently competed in, folded into the
  // major families (historical junior divisions etc. group under Historical)
  const TYPE_FAMILIES = FAM ? FAM.classOrder : ["World Class", "Open Class", "All-Age", "International"];
  const corpsClass = c => {
    for (let i = (c.series || []).length - 1; i >= 0; i--) {
      const k = c.series[i][2];
      if (k) return TYPE_FAMILIES.includes(k) ? k : "Historical";
    }
    return "Historical";
  };

  async function viewCorpsHub(qs, stale) {
    setNav("data");
    const [meta, idx] = await Promise.all([
      data("meta.json"), data("corps_index.json")]);
    if (stale()) return;
    const allYears = [...new Set(meta.seasons.map(s => s.year).concat(
      FAM ? idx.flatMap(c => (c.series || []).map(sr => sr[0])) : []))].sort((a, b) => b - a);
    const bySlug = new Map(idx.map(c => [c.slug, c]));
    const classList = sortClasses([...new Set(idx.map(corpsClass))]);
    const savedCls = localStorage.getItem(NS("dt-corpsclass"));
    let clsFilter = savedCls != null && (savedCls === "" || classList.includes(savedCls))
      ? savedCls
      : (classList.includes("World Class") ? "World Class" : "");
    const classMatch = c => !clsFilter || corpsClass(c) === clsFilter;

    // --- selection state: hash query > session > sensible default ---
    const params = parseHashQuery(qs);
    const explicit = params.c != null || params.y != null;
    let corpsSel, yearsSel;
    if (explicit) {
      corpsSel = (params.c || "").split(",").filter(s => bySlug.has(s));
      yearsSel = (params.y || "").split(",").map(Number).filter(y => allYears.includes(y));
    } else {
      try {
        corpsSel = JSON.parse(sessionStorage.getItem(NS("cmp-corps")) || "null") || [];
        yearsSel = JSON.parse(sessionStorage.getItem(NS("cmp-years")) || "null") || [];
      } catch (e) { corpsSel = []; yearsSel = []; }
      if (!Array.isArray(corpsSel)) corpsSel = [];
      if (!Array.isArray(yearsSel)) yearsSel = [];
      corpsSel = corpsSel.filter(s => bySlug.has(s));
      yearsSel = yearsSel.filter(y => allYears.includes(y));
    }
    // nothing chosen yet? open to a favorited corps if you have one, so the hub
    // lands on someone you care about instead of an empty compare
    if (!explicit && !corpsSel.length) {
      const byName = new Map(idx.map(c => [c.name, c]));
      for (const n of FAVS.list()) {
        const c = byName.get(n);
        if (c) { corpsSel = [c.slug]; if (clsFilter && corpsClass(c) !== clsFilter) clsFilter = corpsClass(c); break; }
      }
    }
    // corps otherwise start empty on purpose — you pick who to compare — but the
    // current season rides pre-selected so one corps pick draws a line
    // (a shared URL or the session's last selection still restores itself)
    if (!yearsSel.length && allYears.length) {
      let pool = allYears;
      if (FAM) {
        const scored = new Set();
        idx.forEach(c => (c.series || []).forEach(sr => { if (sr[1] != null) scored.add(sr[0]); }));
        const p = allYears.filter(y => scored.has(y));
        if (p.length) pool = p;
      }
      yearsSel = [Math.max(...pool)];
    }

    function persist() {
      if (stale()) return; // never rewrite the URL of a view we've left
      sessionStorage.setItem(NS("cmp-corps"), JSON.stringify(corpsSel));
      sessionStorage.setItem(NS("cmp-years"), JSON.stringify(yearsSel));
      const q = `c=${corpsSel.join(",")}&y=${yearsSel.slice().sort((a, b) => b - a).join(",")}`;
      history.replaceState(null, "", `#/compare?${q}`);
    }

    app.innerHTML = `
      ${dataSubNav("compare")}
      <h1 class="page">Compare <span class="kicker">· any ${TERM.singular}, any seasons</span></h1>
      ${noteHtml("compare")}
      <div class="card">
        <h2>Score Progression <span class="sub">pick several ${TERM.plural} and seasons — every ${TERM.singular}-season gets its own line</span></h2>
        <div class="filters" style="margin-bottom:10px">
          <div id="fClass"></div>
          <div id="corpsSel"></div>
          <div id="yearSel"></div>
          <button class="tab" id="clearSel" title="Reset selection">Clear</button>
        </div>
        <div id="cmpNotice"></div>
        <div class="chartwrap" id="cmpChart"><div class="loading">Loading…</div></div>
        <div id="cmpTable" style="margin-top:12px"></div>
      </div>`;

    // --- multiselects ---
    const corpsSet = new Set(corpsSel);
    const yearSet = new Set(yearsSel.map(String));
    const corpsOptions = () => idx.filter(classMatch)
      .sort((a, b) => b.last - a.last || a.name.localeCompare(b.name))
      .map(c => ({ value: c.slug, label: c.name,
        hint: c.first == null ? "" : c.first === c.last ? String(c.first) : `${c.first}–${c.last}` }));
    const msCorps = multiSelect(document.getElementById("corpsSel"), {
      label: "Add " + TERM.plural + " — pick as many as you like…", searchable: true,
      labelFor: v => (bySlug.get(v) || { name: v }).name,
      bulk: true, bulkAll: false,
      options: corpsOptions(),
      selected: corpsSet,
      onChange: v => { corpsSel = v; persist(); draw(); },
    });

    // corps-type filter drives both the dropdown and the directory
    singleSelect(document.getElementById("fClass"), {
      label: "Type",
      options: [{ value: "", label: "All types" }, ...classList.map(c => ({ value: c, label: c }))],
      value: clsFilter,
      onChange: v => {
        clsFilter = v || "";
        localStorage.setItem(NS("dt-corpsclass"), clsFilter);
        msCorps.setOptions(corpsOptions());
      },
    });
    const msYears = multiSelect(document.getElementById("yearSel"), {
      label: "Select seasons…", searchable: allYears.length > 15, bulk: true,
      presets: [{ label: "Past 5", values: () => allYears.slice(0, 5) }],
      options: allYears.map(y => ({ value: String(y), label: String(y) })),
      selected: yearSet,
      onChange: v => { yearsSel = v.map(Number).sort((a, b) => b - a); persist(); draw(); },
    });
    document.getElementById("clearSel").onclick = () => {
      corpsSet.clear(); yearSet.clear();
      corpsSel = [];
      yearsSel = allYears.length ? [Math.max(...allYears)] : [];
      yearsSel.forEach(y => yearSet.add(String(y)));
      msCorps.refresh(); msYears.refresh();
      persist();
      draw();
    };

    // --- chart ---
    const MAX_SERIES = 12;
    let drawGen = 0;
    async function draw() {
      const gen = ++drawGen;
      const chartEl = document.getElementById("cmpChart");
      const tableEl = document.getElementById("cmpTable");
      const noticeEl = document.getElementById("cmpNotice");
      if (!chartEl) return;
      noticeEl.innerHTML = "";
      if (!corpsSel.length || !yearsSel.length) {
        chartEl.innerHTML = `<div class='empty' style="padding:52px 16px">
          <div style="line-height:0;color:var(--muted)" aria-hidden="true"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg></div>
          <div style="font-weight:650;color:var(--text-primary);margin:8px 0 4px">Pick ${TERM.plural} to compare — this season is already selected</div>
          Select as many ${TERM.plural} as you like — each ${TERM.singular}-season draws its own line,<br>
          and its row below expands into the full show-by-show log.</div>`;
        tableEl.innerHTML = "";
        return;
      }
      // snapshot BOTH selections before awaiting so a stale run can't mix
      // old years with new corps
      const corps = corpsSel.slice();
      const years = yearsSel.slice().sort((a, b) => b - a);
      const seasons = await Promise.all(years.map(y => data(`seasons/${y}.json`).catch(() => null)));
      if (gen !== drawGen || stale()) return; // selection changed or view left while loading
      const multiCorps = corps.length > 1, multiYears = years.length > 1;
      const series = [], summary = [];
      let combos = 0, truncated = false;
      for (let ci = 0; ci < corps.length; ci++) {
        const name = bySlug.get(corps[ci]).name;
        for (let yi = 0; yi < years.length; yi++) {
          if (combos >= MAX_SERIES) { truncated = true; break; }
          const evs = seasons[yi];
          if (!evs) continue;
          const pts = [];
          for (const ev of evs) {
            if (!ev.date) continue;
            for (const c of ev.classes || []) {
              for (const r of c.results || []) {
                if (r.corps === name && r.score) pts.push({ x: dayOfSeason(ev.date), y: r.score, ev: ev.name, d: ev.date });
              }
            }
          }
          pts.sort((a, b) => a.x - b.x);
          if (!pts.length) continue;
          combos++;
          const label = multiYears || !multiCorps ? `${name} ’${String(years[yi]).slice(2)}` : name;
          // colors and dashes key off the calendar year itself, not its
          // position in the selection — filtering never recolors a line
          series.push({
            name: label, points: pts,
            color: multiCorps ? corpsColor(name) : PALETTE[years[yi] % PALETTE.length],
            dash: multiCorps && multiYears ? YEAR_DASHES[years[yi] % YEAR_DASHES.length] : "",
          });
          const scores = pts.map(p => p.y);
          const hiPt = pts.reduce((m, p) => p.y > m.y ? p : m, pts[0]);
          const tipOf = p => `${score3(p.y)} — ${p.ev} · ${fmtDateY(p.d)}`;
          summary.push({
            corps: name, year: years[yi], shows: pts.length, list: pts,
            first: scores[0], latest: scores[scores.length - 1],
            high: hiPt.y,
            firstTip: tipOf(pts[0]), latestTip: tipOf(pts[pts.length - 1]), highTip: tipOf(hiPt),
            gain: (scores[scores.length - 1] - scores[0]).toFixed(2),
          });
        }
        if (truncated) break;
      }
      if (truncated) {
        noticeEl.innerHTML = `<div class="notice" style="margin-bottom:10px">Showing the first ${MAX_SERIES} ${TERM.singular}-season lines — trim the selection for a cleaner read.</div>`;
      }
      if (!series.length) {
        chartEl.innerHTML = "<div class='empty'>No scored shows for this selection — try other seasons.</div>";
        tableEl.innerHTML = "";
        return;
      }
      lineChart(chartEl, { linearX: true, series, height: 360, xFmt: dayLabel, yFmt: v => v.toFixed(1) });
      summary.sort((a, b) => b.year - a.year || (b.latest || 0) - (a.latest || 0));
      // each corps-season row expands into its full show-by-show log
      tableEl.innerHTML = `
        <div class="tscroll"><table class="t"><thead><tr><th style="width:26px"></th><th>${TERM_TH}</th><th class="num">Season</th><th class="num m-hide">First</th><th class="num">Latest / Final</th><th class="num m-hide">High</th><th class="num">Gain</th></tr></thead><tbody id="cmpRows">
        ${summary.map((s, si) => h`<tr class="rowlink cmpsum" data-si="${si}" title="Tap for every show that season">
          <td class="cmpcaret" style="color:var(--muted)">▸</td>
          <td>${corpsLink(s.corps)}</td><td class="num">${s.year}</td><td class="num m-hide" data-tip="${esc(s.firstTip)}">${score3(s.first)}</td><td class="num score" data-tip="${esc(s.latestTip)}">${score3(s.latest)}</td><td class="num m-hide" data-tip="${esc(s.highTip)}">${score3(s.high)}</td><td class="num">${s.gain > 0 ? "+" : ""}${s.gain}</td></tr>
        <tr class="cmpdet hid"><td></td><td colspan="6" style="padding:0 8px 12px">
          <table class="t" style="font-size:13px">${s.list.map(p => `<tr><td style="color:var(--muted);white-space:nowrap;width:70px">${fmtDate(p.d)}</td><td>${esc(p.ev)}</td><td class="num score">${score3(p.y)}</td></tr>`).join("")}</table>
        </td></tr>`).join("")}
        </tbody></table></div>`;
      tableEl.querySelectorAll("tr.cmpsum").forEach(tr => tr.onclick = e => {
        if (e.target.closest("a")) return; // the corps link still navigates
        const det = tr.nextElementSibling;
        det.classList.toggle("hid");
        tr.querySelector(".cmpcaret").textContent = det.classList.contains("hid") ? "▸" : "▾";
      });
    }

    persist();
    draw();
  }

  /* ============ CORPS (single-corps tab) ============ */
  async function viewCorpsPage(slug, stale) {
    setNav("corps");
    const idx = await data("corps_index.json");
    if (stale()) return;
    const bySlug = new Map(idx.map(c => [c.slug, c]));
    const classList = sortClasses([...new Set(idx.map(corpsClass))]);
    const savedCls = localStorage.getItem(NS("dt-corpsclass"));
    let clsFilter = savedCls != null && (savedCls === "" || classList.includes(savedCls))
      ? savedCls
      : (classList.includes("World Class") ? "World Class" : "");

    // a deep link picks the corps; otherwise open to a favorited corps if you
    // have one (falling back to the picker prompt when you don't)
    const byName = new Map(idx.map(c => [c.name, c]));
    const favSlug = (() => { for (const n of FAVS.list()) { const c = byName.get(n); if (c) return c.slug; } return null; })();
    const current0 = slug && bySlug.has(slug) ? slug : favSlug;
    let current = current0;
    // the deep-linked corps drives the type filter, not vice versa
    if (current) {
      const t = corpsClass(bySlug.get(current));
      if (clsFilter && t !== clsFilter) clsFilter = t;
    }

    app.innerHTML = `
      <h1 class="page" id="corpsPageTitle">${cap1(TERM.singular === "corps" ? "corps" : TERM.plural)}</h1>
      ${noteHtml("corps")}
      <div class="filters">
        <div id="cpCls"></div>
        <div id="cpCorps"></div>
      </div>
      <div id="corpsDetail"><div class="loading">Loading…</div></div>`;


    const corpsOpts = () => idx
      .filter(c => !clsFilter || corpsClass(c) === clsFilter)
      .sort((a, b) => b.last - a.last || a.name.localeCompare(b.name))
      .map(c => ({ value: c.slug, label: c.name,
        hint: c.first == null ? "" : c.first === c.last ? String(c.first) : `${c.first}–${c.last}` }));
    const pickSet = new Set(current ? [current] : []);
    const msPick = multiSelect(document.getElementById("cpCorps"), {
      label: "Pick " + TERM.a + "…", searchable: true, single: true,
      labelFor: v => (bySlug.get(v) || { name: v }).name,
      options: corpsOpts(),
      selected: pickSet,
      onChange: v => { if (v[0] && v[0] !== current) { current = v[0]; load(); } },
    });
    singleSelect(document.getElementById("cpCls"), {
      label: "Type",
      options: [{ value: "", label: "All types" }, ...classList.map(c => ({ value: c, label: c }))],
      value: clsFilter,
      onChange: v => {
        clsFilter = v || "";
        localStorage.setItem(NS("dt-corpsclass"), clsFilter);
        msPick.setOptions(corpsOpts());
      },
    });

    let detailGen = 0;
    async function load() {
      const gen = ++detailGen;
      const mount = document.getElementById("corpsDetail");
      if (!mount) return;
      mount.innerHTML = "<div class='loading'>Loading…</div>";
      history.replaceState(null, "", `#/corps/${current}`);
      await renderCorpsDetail(current, () => stale() || gen !== detailGen);
    }
    if (current) await load();
    else {
      const favs = FAVS.list().filter(n => bySlug.has(slugOf(n)));
      document.getElementById("corpsDetail").innerHTML = h`<div class="card" style="text-align:center;padding:44px 20px">
        <div style="font-size:34px" aria-hidden="true">🥁</div>
        <h2 style="margin:10px 0 6px">Pick ${TERM.a}</h2>
        <div style="color:var(--muted);font-size:14px;max-width:44ch;margin:0 auto">Choose any ${TERM.singular} above to see season charts, the full performance log, and championship titles${FAM ? "" : " — back to 1972"}.</div>
        ${favs.length ? `<div style="margin-top:14px;font-size:15px">${favs.map(n => corpsLink(n)).join(" · ")}</div>` : ""}
      </div>`;
    }
  }

  async function renderCorpsDetail(slug, stale) {
    const mount = () => document.getElementById("corpsDetail");
    let detail;
    try { detail = await data(`corps/${slug}.json`); }
    catch (e) {
      if (stale() || !mount()) return;
      mount().innerHTML = `<div class="card" style="text-align:center;padding:36px 20px">
        <div class="empty" style="padding:0 0 10px">No scores on record for this ${TERM.singular} yet.</div>
        <a href="#/compare">Browse all ${TERM.plural} →</a></div>`;
      return;
    }
    const [champs, profs] = await Promise.all([
      data("champions.json").catch(() => ({})),
      data("profiles.json").catch(() => ({}))]);
    if (stale() || !mount()) return;
    await LIVE.refresh().catch(() => {});
    if (stale() || !mount()) return;
    const prof = profs[slug];
    const perfs = detail.performances;
    const titles = [];
    for (const [yr, byCls] of Object.entries(champs))
      for (const [cls, w] of Object.entries(byCls))
        if (w.corps === detail.name) titles.push(`${yr} ${cls}`);
    const byYear = new Map();
    perfs.forEach(p => { (byYear.get(p.y) || byYear.set(p.y, []).get(p.y)).push(p); });
    const years = [...byYear.keys()].sort();
    const bestByYear = years.map(y => Math.max(0, ...byYear.get(y).map(p => p.s || 0)) || null);
    const scored = perfs.filter(p => p.s);
    // show-over-show score change within each season — the first scored show of
    // a season is the baseline (0.0), every later show is measured vs the one
    // before it (same idea as the scoreboard's "vs prev" column). Keyed by the
    // perf object so the log can look each one up.
    const deltaByPerf = new Map();
    byYear.forEach(ps => {
      const ordered = ps.filter(p => p.s != null).slice()
        .sort((a, b) => (a.d || "").localeCompare(b.d || ""));
      ordered.forEach((p, i) => deltaByPerf.set(p,
        i === 0 ? (ordered.length > 1 ? 0 : null) : +(p.s - ordered[i - 1].s).toFixed(3)));
    });
    const cmpYears = years.slice(-3).reverse().join(",");

    // does this app publish performance DATES? Without them there is no
    // within-season progression to chart or summarise — the career view is
    // the only honest one.
    const DATED = perfs.some(p => p.d);
    const bestPerf = scored.length ? scored.reduce((m, p) => p.s > m.s ? p : m, scored[0]) : null;
    // the plain page title is replaced by the "wrapped"-style hero below
    const pt = document.getElementById("corpsPageTitle");
    if (pt) pt.hidden = true;

    // ---- wrapped-style hero (mirrors the shareable season card, but live) ----
    const favLabel = () => FAVS.has(detail.name) ? "★ Favorited" : "☆ Favorite";
    const heroPair = corpsPair(detail.name);
    const _hbar = _hx(heroPair.bar), _hacc = _hx(heroPair.accent);
    const heroVars =
      `--ch-bar1:${_rgb(_mix(_hbar, [255, 255, 255], .06))};` +
      `--ch-bar2:${_rgb(_mix(_hbar, [6, 7, 10], .6))};` +
      `--ch-accent:${heroPair.accent};` +
      `--ch-glow:rgba(${_hacc[0]},${_hacc[1]},${_hacc[2]},.36)`;
    const primaryCls = perfs.length ? perfs[perfs.length - 1].cls : "";
    const ordinal = n => {
      if (n == null) return "—";
      const s = ["th", "st", "nd", "rd"], v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };
    // season stats for the focus year — the same four the share card shows
    function seasonAgg(yr) {
      const ps = (byYear.get(yr) || []).filter(p => p.s != null)
        .slice().sort((a, b) => (a.d || "").localeCompare(b.d || ""));
      if (!ps.length) return null;
      const sc = ps.map(p => p.s);
      return {
        high: Math.max(...sc), avg: sc.reduce((a, b) => a + b, 0) / sc.length,
        gained: +(sc[sc.length - 1] - sc[0]).toFixed(3), shows: ps.length,
      };
    }
    const heroHtml = h`
      <div class="corpshero" style="${heroVars}">
        <div class="corpshero-top">
          ${corpsLogo(detail.name, 74, prof && prof.img)}
          <div class="corpshero-id">
            <div class="corpshero-kicker">${esc(primaryCls || (titles.length ? titles.slice().sort()[titles.length - 1].replace(/^\d{4}\s+/, "") : "") || (FAM ? cap1(TERM.plural) : "Drum Corps"))}${titles.length ? ` · ${titles.length} title${titles.length > 1 ? "s" : ""}` : ""}</div>
            <div class="corpshero-name">${esc(detail.name)}${LIVE.corpsLive(detail.name) ? " " + LIVE_BADGE : ""}</div>
            <div class="corpshero-sub" id="heroSub"></div>
          </div>
        </div>
        <div class="corpshero-stats" id="heroStats"></div>
        <div class="corpshero-actions">
          <button id="corpFav" class="ch-btn${FAVS.has(detail.name) ? " on" : ""}">${favLabel()}</button>
          ${years.length ? `<button id="corpCard" class="ch-btn" title="Share this ${TERM.singular}'s season card">${SHARE_SVG} Share</button>` : ""}
        </div>
      </div>`;
    // profile card: who this corps is, straight from Wikipedia
    const factRow = (label, v) => v ? `<span><b>${label}</b> ${esc(v)}</span>` : "";
    const site = prof && prof.website ? (/^https?:/i.test(prof.website) ? prof.website : "https://" + prof.website) : null;
    const profHtml = (prof && (prof.summary || prof.founded || prof.location
      || prof.division || prof.director || prof.website || prof.wiki)) ? h`
      <div class="card profcard" style="margin-bottom:14px">
        ${prof.img ? `<img src="${esc(prof.img)}" alt="${esc(detail.name)} logo" loading="lazy" onerror="this.hidden=true">` : ""}
        <div style="min-width:0">
          <p style="margin:0 0 8px">${esc(prof.summary || "")}</p>
          <div class="facts">
            ${factRow("Founded", prof.founded)}
            ${factRow("Home", prof.location)}
            ${factRow("Division", prof.division)}
            ${prof.disbanded ? factRow("Disbanded", prof.disbanded) : ""}
            ${factRow("Director", prof.director)}
            ${site ? `<span><a href="${encodeURI(site)}" target="_blank" rel="noopener">Website ↗</a></span>` : ""}
            ${prof.wiki ? `<span><a href="${encodeURI(prof.wiki)}" target="_blank" rel="noopener">Wikipedia ↗</a></span>` : ""}
          </div>
        </div>
      </div>` : "";

    mount().innerHTML = h`
      ${heroHtml}
      <div class="filters corps-filters"><div id="yearSel2"></div></div>
      <div class="card corps-chart"><h2 id="corpsChartTitle"></h2><div class="chartwrap" id="corpsChart"></div></div>
      <div class="card corps-perf" style="margin-top:14px"><h2 id="perfTitle">Performance Log</h2>
        ${NOTE("profile") ? `<p class="kicker" style="margin:0 0 8px">${esc(NOTE("profile"))}</p>` : ""}
        <div id="perfTable"></div></div>
      <div class="card corps-champs" style="margin-top:14px"><h2>Championships <span class="sub">${FAM && !DATED ? "every title, and the class it was won in" : "each year's last score &amp; championship finish"}</span></h2>
        <div id="corpChampTable"></div></div>
      <div class="grid cols-tiles corps-tiles" style="margin-top:14px">
        <div class="tile click" id="tilePerfs" role="button" title="Open the full performance log">
          <div class="label">Performances</div><div class="value">${perfs.length}</div>
          <div class="sub">${years.length} seasons · see every show →</div></div>
        <div class="tile click" id="tileBest" role="button" title="Jump to that season">
          <div class="label">Best score</div><div class="value">${bestPerf ? score3(bestPerf.s) : "—"}</div>
          <div class="sub">${bestPerf ? esc(`${bestPerf.ev || ""} · ${bestPerf.y}`) + " →" : ""}</div></div>
        <div class="tile click" id="tileTitles" role="button" title="The full record book">
          <div class="label">Titles</div><div class="value">${titles.length}</div>
          <div class="sub">${esc(titles.length <= 6 ? titles.join(" · ") || "—" : titles.slice(-3).join(" · ") + ` · +${titles.length - 3} more`)} →</div></div>
        ${!CAPS ? "" : `<a class="tile click" href="#/captions?corps=${encodeURIComponent(detail.name)}">
          <div class="label">Caption Scores</div><div class="value">GE · VIS · MUS</div>
          <div class="sub">judge-by-judge breakdowns →</div></a>`}
      </div>
      ${profHtml ? `<div class="corps-prof" style="margin-top:14px">${profHtml}</div>` : ""}`;

    // hero action buttons — favorite (in-place rank), share, and season card
    const fb = document.getElementById("corpFav");
    if (fb) fb.onclick = () => {
      FAVS.toggle(detail.name);
      fb.classList.toggle("on", FAVS.has(detail.name));
      fb.textContent = favLabel();
    };
    const cardBtn = document.getElementById("corpCard");
    if (cardBtn) cardBtn.onclick = async () => {
      if (!window.CadWrapped) return;
      const sel = selYears(), yr = sel.length === 1 ? sel[0] : years[years.length - 1];
      const orig = cardBtn.innerHTML; cardBtn.innerHTML = "Creating…"; cardBtn.disabled = true;
      try { await window.CadWrapped.seasonCard(detail.name, yr); } catch (e) {}
      cardBtn.innerHTML = orig; cardBtn.disabled = false;
    };
    // the hero's season tiles follow the focus year (the latest selected season)
    function renderHero() {
      const yr = selYears().slice(-1)[0] || years[years.length - 1];
      const agg = DATED ? seasonAgg(yr) : null;
      const subEl = document.getElementById("heroSub");
      const statsEl = document.getElementById("heroStats");
      if (subEl) subEl.textContent = agg ? `${yr} season · by the numbers` : `${years.length} season${years.length === 1 ? "" : "s"} on record`;
      if (!statsEl) return;
      const cell = (v, l, id) => `<div class="corpshero-stat"${id ? ` id="${id}"` : ""}><div class="b"></div><div class="v">${v}</div><div class="l">${l}</div></div>`;
      statsEl.innerHTML = agg
        ? cell(score3(agg.high), "Season high")
          + cell("…", "Class rank", "heroRank")
          + cell((agg.gained >= 0 ? "+" : "") + agg.gained.toFixed(2), "Points gained")
          + cell(agg.shows, "Shows")
        : cell(bestPerf ? score3(bestPerf.s) : "—", "Best score")
          + cell(titles.length, "Titles")
          + (FAM && titles.length === perfs.length
            ? cell(years[0] ?? "—", "First title") + cell(years[years.length - 1] ?? "—", "Latest title")
            : cell(perfs.length, "Performances") + cell(years.length, "Seasons"));
      // current standing needs every corps in the class — fill it once it loads
      if (agg && window.CadWrapped && window.CadWrapped.standing) {
        window.CadWrapped.standing(detail.name, yr).then(st => {
          const tile = document.getElementById("heroRank");
          if (!tile || (selYears().slice(-1)[0] || years[years.length - 1]) !== yr) return;
          if (st) { tile.querySelector(".v").textContent = ordinal(st.rank); tile.querySelector(".l").textContent = "Class rank"; }
          else { tile.querySelector(".v").textContent = score3(agg.avg); tile.querySelector(".l").textContent = "Season avg"; }
        });
      }
    }

    // the year filter drives BOTH the chart and the log; one year shows the
    // full season show-by-show, several show top score per year. Default to
    // the corps' most recent season (the current year for an active corps) so
    // clicking in from the scoreboard lands on this season, not all-time.
    const yearSet = new Set(years.length && DATED ? [String(years[years.length - 1])] : []);
    const msYears = multiSelect(document.getElementById("yearSel2"), {
      label: "All years", searchable: years.length > 15, bulk: true, bulkAll: false,
      presets: [{ label: "Past 5", values: () => years.slice(-5).map(String) }],
      options: years.slice().reverse().map(y => ({ value: String(y), label: String(y) })),
      selected: yearSet,
      onChange: () => { renderChart(); renderPerfs(); renderHero(); },
    });
    function selYears() { return [...yearSet].map(Number).sort((a, b) => a - b); }
    function renderChart() {
      const sel = selYears();
      const title = document.getElementById("corpsChartTitle");
      if (sel.length === 1 && DATED) {
        const yv = sel[0];
        title.innerHTML = `${yv} Season Progression <span class="sub">score by date · <a href="#/compare?c=${slug}&y=${cmpYears}">compare seasons →</a></span>`;
        const pts = (byYear.get(yv) || []).filter(p => p.s && p.d)
          .map(p => ({ x: dayOfSeason(p.d), y: p.s })).sort((a, b) => a.x - b.x);
        lineChart(document.getElementById("corpsChart"), {
          linearX: true, series: [{ name: String(yv), points: pts, color: corpsColor(detail.name) }],
          height: 260, xFmt: dayLabel, yFmt: v => v.toFixed(1),
        });
        return;
      }
      // a handful of chosen seasons: overlay each season's full progression,
      // one color per year, on a shared season-day axis
      if (sel.length > 1 && sel.length <= 8 && DATED) {
        const series = sel.map(yv => ({
          name: String(yv), color: PALETTE[yv % PALETTE.length],
          points: (byYear.get(yv) || []).filter(p => p.s && p.d)
            .map(p => ({ x: dayOfSeason(p.d), y: p.s })).sort((a, b) => a.x - b.x),
        })).filter(sr => sr.points.length);
        if (series.length) {
          title.innerHTML = `Season Progression — ${sel[0]}–${sel[sel.length - 1]} <span class="sub">one line per season · <a href="#/compare?c=${slug}&y=${cmpYears}">compare vs other ${TERM.plural} →</a></span>`;
          lineChart(document.getElementById("corpsChart"), {
            linearX: true, series,
            height: 260, xFmt: dayLabel, yFmt: v => v.toFixed(1),
          });
          return;
        }
      }
      // top score per season — the line only connects consecutive seasons,
      // so years the corps didn't march show as real gaps and an in-progress
      // season sits as its own point instead of dragging the line
      const range = sel.length ? `${sel[0]}–${sel[sel.length - 1]}` : "";
      title.innerHTML = `${FAM && !DATED ? "Title Score by Season" : "Top Score by Year"}${range ? ` — ${range}` : ""} <span class="sub">${FAM && !DATED ? "one point per title — a gap is a season they did not win" : "gaps = seasons not yet in the database"} · <a href="#/compare?c=${slug}&y=${cmpYears}">compare seasons →</a></span>`;
      const ptsAll = years.map((y, i) => ({ x: y, y: bestByYear[i] }))
        .filter(p => p.y && (!sel.length || yearSet.has(String(p.x))));
      const segs = [];
      let cur = [];
      for (const p of ptsAll) {
        if (DATED && cur.length && p.x - cur[cur.length - 1].x > 1) { segs.push(cur); cur = []; }
        cur.push(p);
      }
      if (cur.length) segs.push(cur);
      lineChart(document.getElementById("corpsChart"), {
        linearX: true, noLegend: true,
        series: segs.map(pts => ({ name: "Top score", points: pts, color: corpsColor(detail.name) })),
        height: 260, yFmt: v => v.toFixed(0), xFmt: v => String(Math.round(v)),
      });
    }

    function renderPerfs() {
      const sel = selYears();
      const selNote = sel.length === 0 ? "" : sel.length === 1 ? `${sel[0]} only` : `${sel.length} seasons`;
      document.getElementById("perfTitle").innerHTML =
        `Performance Log${selNote ? ` <span class="sub">${esc(selNote)}</span>` : ""}`;
      const list = perfs.filter(p => !sel.length || yearSet.has(String(p.y)))
        .sort((a, b) => (b.d || "").localeCompare(a.d || "") || b.y - a.y);
      document.getElementById("perfTable").innerHTML = `<div class="tscroll"><table class="t">
        <thead><tr><th>Date</th><th>Event</th><th class="m-hide">Class</th><th class="num">Place</th><th class="num">Score</th>${!DATED ? "" : `<th class="num" title="Change from this ${TERM.singular}'s previous show that season">vs prev</th>`}</tr></thead>
        <tbody id="perfRows">${list.length ? "" : `<tr><td colspan="${DATED ? 6 : 5}" class="empty">No performances on record${selNote ? " for " + esc(selNote) : ""}.</td></tr>`}${list.slice(0, 600).map(p => h`<tr>
          <td style="color:var(--muted);white-space:nowrap">${fmtDate2(p.d, p.y)}</td>
          <td>${esc(p.ev || "")}</td>
          <td class="m-hide"><span class="pill">${esc(p.cls || "")}</span></td>
          <td class="num">${p.p ?? "—"}</td><td class="num score">${score3(p.s)}</td>
          ${!DATED ? "" : `<td class="num">${p.s == null ? '<span class="delta flat">—</span>' : deltaHtml(deltaByPerf.get(p))}</td>`}</tr>`).join("")}</tbody></table></div>`;
      collapseRows(document.getElementById("perfRows"), 3, "performances");
    }

    // Championships table: one row per year — the season's last score and where
    // they finished at the World Championships (their latest championship round
    // that year: Finals when they made it, else Semifinals / Prelims). Newest
    // first; the last three years show, the rest expand.
    function renderCorpChamps() {
      const roundOf = ev => /semi/i.test(ev) ? "Semifinals" : /quarter/i.test(ev) ? "Quarterfinals"
        : /prelim/i.test(ev) ? "Prelims" : /final/i.test(ev) ? "Finals" : "";
      const rows = years.slice().reverse().map(y => {
        const ps = (byYear.get(y) || []).filter(p => p.s != null)
          .slice().sort((a, b) => (a.d || "").localeCompare(b.d || ""));
        if (!ps.length) return null;
        const last = ps[ps.length - 1];
        const champs = ps.filter(p => /world championship/i.test(p.ev || "") && p.p != null);
        const fin = champs.length ? champs[champs.length - 1] : null;
        return { y, last, fin };
      }).filter(Boolean);
      document.getElementById("corpChampTable").innerHTML = `<div class="tscroll"><table class="t">
        <thead><tr><th>Year</th><th class="num">Last score</th><th>Championship finish</th></tr></thead>
        <tbody id="corpChampRows">${rows.length ? "" : '<tr><td colspan="3" class="empty">No championship results on record.</td></tr>'}${rows.map(r => h`<tr>
          <td><a href="#/season/${r.y}"><b>${r.y}</b></a></td>
          <td class="num score">${score3(r.last.s)}</td>
          <td>${r.fin ? h`<b>${ordinal(r.fin.p)}</b> <span class="kicker">${[roundOf(r.fin.ev || ""), r.fin.cls].filter(Boolean).map(x => " · " + esc(x)).join("")}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
        </tr>`).join("")}</tbody></table></div>`;
      collapseRows(document.getElementById("corpChampRows"), 3, "years");
    }
    renderChart();
    renderPerfs();
    renderCorpChamps();
    renderHero();

    // stat tiles double as drill-downs
    document.getElementById("tilePerfs").onclick = () => {
      // "see every show" — clear the season filter so the whole career shows
      yearSet.clear();
      msYears.refresh();
      renderChart();
      renderPerfs();
      renderHero();
      const btn = document.querySelector("#perfTable .expandwrap .tab");
      if (btn && document.querySelector("#perfRows tr.hid")) btn.click();
      document.getElementById("perfTitle").scrollIntoView({ block: "start", behavior: "smooth" });
    };
    document.getElementById("tileBest").onclick = () => {
      if (!bestPerf) return;
      yearSet.clear();
      yearSet.add(String(bestPerf.y));
      msYears.refresh();
      renderChart();
      renderPerfs();
      renderHero();
      document.getElementById("corpsChartTitle").scrollIntoView({ block: "start", behavior: "smooth" });
    };
    document.getElementById("tileTitles").onclick = () => { location.hash = "#/seasons"; };
  }

  /* ============ SEASONS ============ */
  async function viewSeasons(_m, stale) {
    setNav("data");
    const [meta, champs] = await Promise.all([
      data("meta.json"), data("champions.json").catch(() => ({}))]);
    if (stale()) return;
    const years = meta.seasons.slice();
    if (FAM) {
      const have = new Set(years.map(s => s.year));
      Object.keys(champs || {}).forEach(y => { if (!have.has(+y)) years.push({ year: +y }); });
    }
    years.sort((a, b) => b.year - a.year);
    // COVID years appear as labeled rows inside the era they interrupt
    const yrNums = years.map(s => s.year);
    [2020, 2021].forEach(cy => {
      if (yrNums.some(n => n > cy) && yrNums.some(n => n < cy))
        years.push({ year: cy, covid: true });
    });
    years.sort((a, b) => b.year - a.year);
    app.innerHTML = h`
      ${dataSubNav("champions")}
      <h1 class="page">Champions <span class="kicker">· the record book${FAM ? "" : ", 1972–today"}</span></h1>
      <div class="card"><h2>Past Champions <span class="sub" id="champSub"></span></h2>
      <div class="filters" style="margin-bottom:8px"><div id="champCls"></div></div>
      <div class="tscroll"><table class="t" id="champT"></table></div>
      <p style="color:var(--muted);font-size:12.5px;margin:10px 2px 0">${FAM ? "Tap a year for that season's championships." : "Tap a year for that season — every show, every score, full recaps."}</p>
      <div id="champChartWrap" hidden style="margin-top:16px">
        <h2>Winning Score by Year <span class="sub" id="champChartSub"></span></h2>
        <div class="chartwrap" id="champChart"></div>
      </div></div>`;
    if (FAM) (async () => {
      try {
        const ch = await data("champions.json");
        const years = Object.keys(ch).sort();
        const latest = years[years.length - 1];
        if (!latest || !ch[latest]) return;
        const ordered = CLASS_ORDER.filter(c => ch[latest][c])
          .concat(Object.keys(ch[latest]).filter(c => !CLASS_ORDER.includes(c)));
        if (!ordered.length) return;
        const card = document.createElement("div");
        card.className = "card";
        card.innerHTML = `<h2>Reigning Champions <span class="sub">${esc(String(latest))} titles</span></h2>
          <div class="champ-grid">` + ordered.map(c => {
            const w = ch[latest][c];
            const score = w.score != null ? `<span class="champ-tile-s">${esc(String(w.score))}</span>` : "";
            return `<a class="champ-tile" href="#/corps/${slugOf(w.corps)}">${corpsLogo(w.corps, 36)}
              <span class="champ-tile-t"><span class="champ-tile-cls">${esc(c)}</span>
              <b>${esc(w.corps)}</b>${score}</span></a>`;
          }).join("") + `</div>`;
        const h1 = app.querySelector("h1.page");
        if (h1 && !stale()) h1.after(card);
      } catch (e) {}
    })();

    // one table: every season, its champion, click through to the year
    if (FAM && !Object.keys(champs || {}).length) {
      const t = document.getElementById("champT");
      if (t) t.innerHTML = "<tbody><tr><td class='empty'>The record book fills in with this app's first full season of data.</td></tr></tbody>";
      const cs = document.getElementById("champSub");
      if (cs) cs.textContent = "";
      return;
    }
    const clsSet = new Set();
    Object.values(champs).forEach(byCls => Object.keys(byCls).forEach(c => clsSet.add(c)));
    const clsList = sortClasses([...clsSet]);
    let champCls = clsList.includes("World Class") ? "World Class" : clsList[0];
    const currentYear = Math.max(...years.map(s => s.year));
    let ssChampCls = null;
    function renderChamps() {
      if (!ssChampCls) {
        ssChampCls = singleSelect(document.getElementById("champCls"), {
          label: "Class", options: clsList.map(c => ({ value: c, label: c })), value: champCls,
          onChange: v => { champCls = v; renderChamps(); },
        });
      }
      document.getElementById("champSub").textContent = `${champCls} · every season on record`;
      // World Class shows every scraped season; other classes show the
      // seasons they actually crowned a champion (plus the running season)
      const withChamp = new Set(Object.keys(champs).filter(y => champs[y][champCls]).map(Number));
      const rowsList = [];
      years.forEach(s => {
        if (s.covid) return; // inserted after, only if this class spans the gap
        const w = champs[String(s.year)] && champs[String(s.year)][champCls];
        if (champCls === "World Class" || w || s.year === currentYear)
          rowsList.push({ y: s.year, w, events: s.events });
      });
      const clsYears = rowsList.map(r => r.y);
      [2020, 2021].forEach(cy => {
        if (clsYears.some(y => y > cy) && clsYears.some(y => y < cy))
          rowsList.push({ y: cy, covid: true });
      });
      rowsList.sort((a, b) => b.y - a.y);
      document.getElementById("champT").innerHTML = `
        <thead><tr><th>Year</th><th>Champion</th><th class="num">Score</th></tr></thead><tbody id="champRows">
        ${rowsList.map(r => {
          if (r.covid) return `<tr><td style="color:var(--muted)">${r.y}</td><td colspan="2" style="color:var(--muted)">COVID-19 — ${FAM ? "no championship on record" : r.y === 2020 ? "season canceled, no championships" : "no championships held"}</td></tr>`;
          const label = r.w
            ? `<b>${esc(r.w.corps)}</b>`
            : (r.y === currentYear
              ? (FAM ? "<span style='color:var(--muted)'>scheduled · no results published</span>" : "<span style='color:var(--muted)'>season in progress…</span>")
              : "<span style='color:var(--muted)'>—</span>");
          const jump = !FAM || r.w ? `#/season/${r.y}` : r.events ? `#/events?y=${r.y}` : "";
          return `<tr${jump ? ` class="rowlink" data-h="${jump}"` : ""}><td>${jump ? `<a href="${jump}"><b>${r.y}</b></a>` : `<b>${r.y}</b>`}${r.events ? ` <span class="kicker">${r.events} events</span>` : ""}</td><td>${label}</td><td class="num score">${r.w && r.w.score ? score3(r.w.score) : "—"}</td></tr>`;
        }).join("")}</tbody>`;
      document.querySelectorAll("#champRows tr[data-h]").forEach(tr => {
        tr.onclick = e => {
          if (e.target.closest("a")) return;
          location.hash = tr.dataset.h;
        };
      });
      collapseRows(document.getElementById("champRows"), 5, "seasons");

      // the winning score, year over year — gaps stay gaps
      const pts = rowsList.filter(r => r.w && r.w.score)
        .map(r => ({ x: r.y, y: r.w.score })).sort((a, b) => a.x - b.x);
      const segs = [];
      let seg = [];
      pts.forEach(pt => {
        if (seg.length && pt.x - seg[seg.length - 1].x > 1) { segs.push(seg); seg = []; }
        seg.push(pt);
      });
      if (seg.length) segs.push(seg);
      const wrap = document.getElementById("champChartWrap");
      if (pts.length >= 3) {
        wrap.hidden = false;
        document.getElementById("champChartSub").textContent = `${champCls} title score by season`;
        lineChart(document.getElementById("champChart"), {
          linearX: true, noLegend: true,
          series: segs.map(sg => ({ name: "Winning score", points: sg, color: "#d97706" })),
          height: 240, yFmt: v => v.toFixed(1), xFmt: v => String(Math.round(v)),
        });
      } else {
        wrap.hidden = true;
      }
    }
    renderChamps();
  }

  function eventWinner(ev) {
    let winner = null;
    for (const c of ev.classes || []) {
      const r0 = (c.results || []).find(r => r.score);
      if (r0 && (!winner || (r0.score || 0) > (winner.score || 0))) winner = r0;
    }
    return winner;
  }

  /* ===== venue-local schedule times → the viewer's own clock =====
     DCI event pages print wall-clock venue time with no zone; the venue's
     state gives us its IANA zone, Intl does the DST-correct conversion. */
  const STATE_TZ = (() => {
    const m = {};
    const put = (tz, sts) => sts.split(" ").forEach(st => { m[st] = tz; });
    put("America/New_York", "CT DE DC FL GA IN KY MA MD ME MI NC NH NJ NY OH PA RI SC VA VT WV");
    put("America/Chicago", "AL AR IA IL KS LA MN MO MS ND NE OK SD TN TX WI");
    put("America/Denver", "CO ID MT NM UT WY");
    put("America/Phoenix", "AZ");
    put("America/Los_Angeles", "CA NV OR WA");
    put("America/Anchorage", "AK");
    put("Pacific/Honolulu", "HI");
    return m;
  })();
  function venueZone(location) {
    const m = /,\s*([A-Z]{2})\b/.exec(location || "");
    return m ? STATE_TZ[m[1]] : null;
  }
  function tzOffsetMin(tz, date) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false, year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(date).map(p => [p.type, p.value]));
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
    return (asUTC - date.getTime()) / 60000;
  }
  function tzAbbr(tz, date) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(date).find(x => x.type === "timeZoneName");
    return p ? p.value : "";
  }
  // "7:52 PM" at the venue on isoDate → the same instant on the viewer's clock
  function localizeVenueTime(t, isoDate, tz) {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec((t || "").trim());
    if (!m || !isoDate || !tz) return null;
    let h = +m[1] % 12;
    if (/pm/i.test(m[3])) h += 12;
    const [y, mo, d] = isoDate.split("-").map(Number);
    const min = +(m[2] || 0);
    let utc = Date.UTC(y, mo - 1, d, h, min);
    utc -= tzOffsetMin(tz, new Date(utc)) * 60000;
    utc = Date.UTC(y, mo - 1, d, h, min) - tzOffsetMin(tz, new Date(utc)) * 60000;
    return new Date(utc).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  // the timed running order for a show — a LIVE pill rides next to whichever
  // corps are inside their ±15-min window right now. Split out so a live view
  // can repaint just these rows as the running order advances.
  function scheduleRowsHtml(ev) {
    const tz = venueZone(ev.location);
    const sameZone = !tz || tz === Intl.DateTimeFormat().resolvedOptions().timeZone;
    const abbr = tz ? tzAbbr(tz, ev.date ? new Date(ev.date + "T12:00:00") : new Date()) : "";
    const done = LIVE.isComplete(ev.name); // scores all in → nothing here is live
    return (ev.schedule || []).map(([t, entry]) => {
      const isCorps = (ev.lineup || []).includes(entry) && !NON_CORPS.test(entry);
      const shown = sameZone ? t : (localizeVenueTime(t, ev.date, tz) || t);
      // any slot inside its ±15-min window is live — corps and logistics rows
      // alike — until the show completes, and a corps that already scored drops
      const live = !done && LIVE.slotLiveAt(ev.date, t, tz) && !(isCorps && LIVE.scored(entry));
      return `<tr${live ? ' class="evlive"' : ""}><td class="num" style="color:var(--muted);white-space:nowrap"${shown !== t ? ` title="${esc(t)} ${esc(abbr)} at the venue"` : ""}>${esc(shown || "")}</td><td>${isCorps ? corpsLink(entry) : `<span style="color:var(--muted)">${esc(entry)}</span>`}${live ? " " + LIVE_BADGE : ""}</td></tr>`;
    }).join("");
  }

  function eventBodyHtml(ev, year, i) {
    // off-season entry (camp / auditions): a details card, not a scoreboard
    if (ev.kind) {
      const range = ev.end && ev.end !== ev.date
        ? `${fmtDateY(ev.date)} – ${fmtDateY(ev.end)}` : fmtDateY(ev.date);
      return h`
        <div class="offbody">
          <div>${esc(range)}${ev.location ? " · " + esc(ev.location) : ""}</div>
          ${ev.corps ? h`<div style="margin-top:6px">Hosted by ${corpsLink(ev.corps)}</div>` : ""}
          ${ev.url ? `<a class="tab" style="margin-top:10px;display:inline-block" href="${encodeURI(ev.url)}" target="_blank" rel="noopener">Details &amp; registration ↗</a>` : ""}
        </div>`;
    }
    if (ev.future) {
      const mapLink = (ev.location
        ? `<p style="font-size:12.5px;color:var(--muted);margin:8px 0 0"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((ev.name || "") + " " + ev.location)}" target="_blank" rel="noopener">Venue map ↗</a></p>`
        : "") + (ev.url
        ? `<p style="font-size:12.5px;color:var(--muted);margin:6px 0 0"><a href="${encodeURI(ev.url)}" target="_blank" rel="noopener">${icoSvg(ICO_TICKET, 13)} Venue info — bag policy, tickets, parking ↗</a></p>`
        : "");
      if (ev.schedule && ev.schedule.length) {
        // show the viewer their own clock; note the venue's zone when it differs
        const tz = venueZone(ev.location);
        const sameZone = !tz || tz === Intl.DateTimeFormat().resolvedOptions().timeZone;
        const abbr = tz ? tzAbbr(tz, ev.date ? new Date(ev.date + "T12:00:00") : new Date()) : "";
        const kick = sameZone
          ? `${ev.lineup.length} corps · ${abbr ? "local time (" + abbr + ")" : "venue time"}`
          : `${ev.lineup.length} corps · shown in your time — venue is on ${abbr}`;
        return h`<h3 class="evcls">Schedule <span class="kicker">${kick}</span></h3>
          <table class="t"><tbody class="evsched" data-i="${i}">
          ${scheduleRowsHtml(ev)}
          </tbody></table>
          <div class="predictmount"></div>
          ${mapLink}`;
      }
      return (ev.lineup || []).length
        ? h`<h3 class="evcls">Scheduled Lineup <span class="kicker">${ev.lineup.length} ${TERM.plural}</span></h3>
            <table class="t"><tbody>
            ${ev.lineup.map(c => { const live = LIVE.corpsLive(c);
              return `<tr${live ? ' class="evlive"' : ""}><td>${corpsLink(c)}${live ? " " + LIVE_BADGE : ""}</td><td class="num" style="color:var(--muted)">${live ? "" : "upcoming"}</td></tr>`; }).join("")}
            </tbody></table>
            <div class="predictmount"></div>
            ${mapLink}`
        : `<div class='empty'>Lineup not announced yet.</div>${mapLink}`;
    }
    // full page / caption sheet is the most-wanted jump — sit it up top, right
    // of the first class heading, so it's the first thing you see and tap
    const fullLink = `<a href="#/event/${year}/${i}" class="evfull">${ev.has_recap ? icoSvg(ICO_TROPHY, 13) + " Captions & full page →" : "Full event page →"}</a>`;
    return h`
      ${(ev.classes || []).map((c, ci) => h`
        <h3 class="evcls evcls-row">${esc(c.label || c.class)} <span class="kicker">${c.results.length} ${TERM.plural}</span>${ci === 0 ? fullLink : ""}</h3>
        <table class="t"><tbody>
        ${c.results.map(r => `<tr><td class="rank">${r.place ?? "—"}</td><td>${corpsLink(r.corps)}</td><td class="num score">${score3(r.score)}</td></tr>`).join("")}
        </tbody></table>`).join("")}
      <div class="predictmount"></div>`;
  }

  async function viewEvents(qs, stale) {
    setNav("events");
    const meta = await data("meta.json");
    if (stale()) return;
    const params = parseHashQuery(qs);
    const years = meta.seasons.map(sn => sn.year).sort((a, b) => b - a);
    let year = +params.y && years.includes(+params.y) ? +params.y : years[0];
    app.innerHTML = `
      <h1 class="page">${FAM ? FAM.eventsTitle : "Shows"} ${yearPickerHtml(year)} <span class="kicker" id="evCount"></span></h1>
      ${noteHtml("events")}
      <div class="filters" style="justify-content:flex-end">
        <button class="tab" id="fToggle" aria-expanded="false">Filters ▾</button>
      </div>
      <div id="seasonMount"><div class="loading">Loading…</div></div>`;
    let gen = 0;
    async function load() {
      const g = ++gen;
      history.replaceState(null, "", `#/events?y=${year}`);
      const mount = document.getElementById("seasonMount");
      if (mount) mount.innerHTML = "<div class='loading'>Loading…</div>";
      await renderSeason(year, () => stale() || g !== gen);
    }
    // the year IS the control (same component as the Scoreboard). Picking a
    // season re-routes, so the whole view rebuilds with the new heading —
    // exactly how the Scoreboard picker behaves.
    wireYearPicker(years, year, y => { location.hash = `#/events?y=${y}`; });
    await load();
  }

  /* News & Announcements: DCI.org headlines + the weekly per-corps roundup
     (auditions, camps, next-season reveals), scraped into news.json. Items
     newer than the last visit get a NEW pill — the in-app "notification". */
  function renderNews(mountEl, news) {
    if (!mountEl) return;
    const items = (news && news.items) || [];
    const articles = ((news && news.articles) || []).filter(a => !/corps-news-and-announcements/.test(a.url));
    if (!items.length && !articles.length) { mountEl.innerHTML = ""; return; }
    let lastSeen = "";
    try { lastSeen = localStorage.getItem("cad-news-seen") || ""; } catch (e) {}
    const PRI = { auditions: 0, announcement: 1, news: 2 };
    // your starred corps' announcements surface first within each day
    const fv = x => (x.corps && FAVS.has(x.corps) ? 0 : 1);
    const sorted = items.slice().sort((a, b) =>
      (b.date || "").localeCompare(a.date || "") || fv(a) - fv(b) || (PRI[a.kind] ?? 9) - (PRI[b.kind] ?? 9));
    const isNew = x => x.date && lastSeen && x.date > lastSeen;
    const anyNew = !lastSeen || sorted.some(isNew) || articles.some(isNew);
    const kindPill = k => k === "auditions" ? '<span class="pill kpill kaud">Auditions</span>'
      : k === "announcement" ? '<span class="pill kpill kspec">Announcement</span>' : "";
    const cardHtml = it => h`<div class="newscard">
        ${it.logo ? `<img class="newslogo" src="${encodeURI(it.logo)}" alt="" loading="lazy" onerror="this.hidden=true">` : ""}
        <div class="newsbody">
          <div class="newstop"><b>${esc(it.corps)}</b>${kindPill(it.kind)}${isNew(it) ? '<span class="pill kpill knew">New</span>' : ""}</div>
          <div class="newstxt">${esc(it.blurb)}</div>
          ${it.link ? `<a class="newsgo" href="${encodeURI(it.link)}" target="_blank" rel="noopener">See more ↗</a>` : ""}
        </div>
      </div>`;
    const CUT = 2; // keep the tile short — a couple of cards, expand for the rest
    // the whole tile collapses to just its header, remembered per device.
    // Collapsed by DEFAULT — news stays out of the way until the reader opens
    // it (the header keeps a "New" pill so fresh items still announce
    // themselves). It expands only once someone has explicitly opened it.
    let collapsed = true;
    try { collapsed = localStorage.getItem("cad-news-collapsed") !== "0"; } catch (e) {}
    mountEl.innerHTML = h`<div class="card newswrap${collapsed ? " collapsed" : ""}">
      <h2 class="newsh2"><button class="newshead" type="button" aria-controls="newsInner" aria-expanded="${collapsed ? "false" : "true"}">
        <span class="newshtxt">News &amp; Announcements <span class="sub">auditions, camps &amp; corps news · via DCI.org</span></span>
        ${anyNew ? '<span class="pill kpill knew">New</span>' : ""}<span class="newschev" aria-hidden="true">${CHEVRON_SVG}</span>
      </button></h2>
      <div class="newsinner" id="newsInner"${collapsed ? " hidden" : ""}>
        ${articles.slice(0, 2).map(a => h`<a class="newshl${isNew(a) ? " new" : ""}" href="${encodeURI(a.url)}" target="_blank" rel="noopener"><span class="newshl-d">${esc(fmtDate(a.date))}</span>${esc(a.title)}${isNew(a) ? ' <span class="pill kpill knew">New</span>' : ""}</a>`).join("")}
        <div class="dsk2 newsgrid">${sorted.slice(0, CUT).map(cardHtml).join("")}</div>
        ${sorted.length > CUT ? `<div class="dsk2 newsgrid" id="newsMore" hidden>${sorted.slice(CUT).map(cardHtml).join("")}</div>
          <button class="tab newsmorebtn" type="button">All corps news (${sorted.length}) ▾</button>` : ""}
      </div>
    </div>`;
    const head = mountEl.querySelector(".newshead");
    const inner = mountEl.querySelector("#newsInner");
    const wrap = mountEl.querySelector(".newswrap");
    // Marking items "seen" advances cad-news-seen, which clears the New badge.
    // Only do that once the content is actually on screen — a collapsed tile
    // has shown the reader nothing, so its New pill must survive until they
    // open it (otherwise it flashes once and is gone on the next navigation).
    const maxDate = [...sorted, ...articles].reduce((m, x) => (x.date || "") > m ? x.date : m, "");
    const markSeen = () => {
      if (anyNew && maxDate) { try { localStorage.setItem("cad-news-seen", maxDate); } catch (e) {} }
    };
    if (head) head.onclick = () => {
      const nowCollapsed = !inner.hidden;
      inner.hidden = nowCollapsed;
      wrap.classList.toggle("collapsed", nowCollapsed);
      head.setAttribute("aria-expanded", nowCollapsed ? "false" : "true");
      try { localStorage.setItem("cad-news-collapsed", nowCollapsed ? "1" : "0"); } catch (e) {}
      // opening it counts as seeing it: bank the date and drop the header badge
      if (!nowCollapsed) { markSeen(); const pill = head.querySelector(".knew"); if (pill) pill.remove(); }
    };
    const more = mountEl.querySelector(".newsmorebtn");
    if (more) more.onclick = () => {
      const p = mountEl.querySelector("#newsMore");
      p.hidden = !p.hidden;
      more.textContent = p.hidden ? `All corps news (${sorted.length}) ▾` : "Fewer ▴";
    };
    if (!collapsed) markSeen(); // rendered already open → it's been seen
  }

  async function renderSeason(year, stale) {
    const mount = () => document.getElementById("seasonMount");
    let events;
    try { events = await data(`seasons/${year}.json`); }
    catch (e) {
      if (!stale() && mount()) mount().innerHTML = "<div class='card'><div class='empty'>No data for this season yet.</div></div>";
      return;
    }
    if (stale() || !mount()) return;
    await LIVE.refresh().catch(() => {});
    if (stale() || !mount()) return;

    // running season: the schedule's future events join the list, marked
    // "upcoming" — the season page is the one place with the whole summer
    events = events.slice(); // never mutate the array shared by the data() cache
    let news = null;
    if (+year === new Date().getFullYear()) {
      const up = await data("upcoming.json").catch(() => []);
      if (stale()) return;
      const seen = new Set(events.map(e => (e.date || "") + "|" + (e.name || "").toLowerCase()));
      for (const u of up) {
        if (!u.date || !String(u.date).startsWith(String(year))) continue;
        if (seen.has(u.date + "|" + (u.name || "").toLowerCase())) continue;
        events.push({ name: u.name, date: u.date, location: u.location,
          lineup: u.lineup || [], schedule: u.schedule, url: u.url, future: true });
      }
      // off-season calendar: camps / auditions / special events with confirmed
      // dates. They ride in the same list but are styled apart, so real
      // competitive shows keep the spotlight.
      const off = FAM ? [] : await data("offseason.json").catch(() => []);
      if (stale()) return;
      for (const o of off || []) {
        if (!o.date || !String(o.date).startsWith(String(year))) continue;
        if (seen.has(o.date + "|" + (o.name || "").toLowerCase())) continue;
        events.push({ name: o.name, date: o.date, end: o.end, location: o.location,
          url: o.url, corps: o.corps, kind: o.kind || "camp", future: true });
      }
      // corps announcements + DCI headlines, scraped from dci.org/news
      news = FAM ? null : await data("news.json").catch(() => null);
      if (stale()) return;
    }

    // filter option sets from the actual data
    const clsSet = new Set();
    events.forEach(ev => (ev.classes || []).forEach(c => clsSet.add(c.class)));
    const clsList = sortClasses([...clsSet]);

    // World Class corps this season (+ a rank by season-best score) so the
    // prediction game knows which lineup names to rank and can auto-fill
    const wcCorps = new Set();
    const wcBest = {};
    events.forEach(ev => (ev.classes || []).forEach(c => {
      if (c.class !== "World Class") return;
      (c.results || []).forEach(r => {
        wcCorps.add(r.corps);
        wcBest[r.corps] = Math.max(wcBest[r.corps] || 0, r.score || 0);
      });
    }));
    const wcRank = {};
    Object.keys(wcBest).sort((a, b) => wcBest[b] - wcBest[a]).forEach((c, i) => { wcRank[c] = i; });
    // this season's graded calls, for the little record strip
    const graded = [];
    events.forEach(ev => {
      const p = PREDS.get(pinKeyOf(ev)), ord = wcOrder(ev);
      if (p && ord.length) graded.push(scorePred(p.order, ord).pct);
    });
    const recordStrip = graded.length
      ? `<a class="pr-record" href="#/predictions">${TARGET_SVG} Your calls · ${graded.length} show${graded.length > 1 ? "s" : ""} · `
        + `avg ${Math.round(graded.reduce((a, b) => a + b, 0) / graded.length)}% · best ${Math.max(...graded)}% <span class="pr-record-go">See all →</span></a>`
      : "";

    const cnt = document.getElementById("evCount");
    if (cnt) cnt.textContent = `· ${events.filter(e => !e.future).length} events${events.some(e => e.future) ? `, ${events.filter(e => e.future).length} upcoming` : ""}`;
    mount().innerHTML = h`
      <div class="filters fpanel" id="fPanel" hidden>
        <div id="fCls"></div>
        <div id="fCorps"></div>
        <input class="ctrl" id="fQ" placeholder="Search event or city…">
        <button class="tab" id="toggleAll">Expand all ▾</button>
      </div>
      <div id="evcount" class="kicker" style="margin:0 0 10px"></div>
      ${recordStrip}
      <div id="newsMount"></div>
      <div id="evlist"></div>`;

    const list = document.getElementById("evlist");
    renderNews(document.getElementById("newsMount"), news);

    function toggle(row, force) {
      const body = row.querySelector(".evbody");
      const head = row.querySelector(".evhead");
      const open = force != null ? force : body.hidden;
      if (open && !body.dataset.filled) {
        const i = +row.dataset.i;
        body.innerHTML = eventBodyHtml(events[i], year, i);
        body.querySelectorAll(".predictmount").forEach(mnt => mountPredict(mnt, events[i], wcCorps, wcRank));
        body.dataset.filled = "1";
      }
      body.hidden = !open;
      row.classList.toggle("open", open);
      head.setAttribute("aria-expanded", String(open));
    }

    function matches(ev, cls, q) {
      if (cls && !(ev.classes || []).some(c => c.class === cls)) return false;
      if (corpsPick.size) {
        const featured = (ev.lineup || []).some(c => corpsPick.has(c)) ||
          (ev.corps && corpsPick.has(ev.corps)) ||
          (ev.classes || []).some(c => (c.results || []).some(r => corpsPick.has(r.corps)));
        if (!featured) return false;
      }
      if (cls && ev.future) return false;
      if (q) {
        const hay = (ev.name + " " + (ev.location || "")).toLowerCase();
        const inCorps = (ev.classes || []).some(c =>
          (c.results || []).some(r => (r.corps || "").toLowerCase().includes(q)))
          || (ev.lineup || []).some(c => c.toLowerCase().includes(q));
        if (!hay.includes(q) && !inCorps) return false;
      }
      return true;
    }

    // off-season entries (camps, auditions) carry a `kind`; real shows don't.
    // Shows keep the strong gold-edged card so competition always stands out.
    const KIND_PILL = { camp: '<span class="pill kpill kcamp">Camp</span>',
      auditions: '<span class="pill kpill kaud">Auditions</span>',
      special: '<span class="pill kpill kspec">Event</span>' };
    function rowHtml([ev, i]) {
      const winner = eventWinner(ev);
      const live = LIVE.showLive(ev); // currently performing (schedule window, scores not in)
      const off = !!ev.kind;
      return h`<div class="evrow card ${off ? "evoff" : "evshow"}${live ? " evlive" : ""}" data-i="${i}">
        <button class="evhead" aria-expanded="false">
          <span class="evwhen">${fmtDate2(ev.date, ev.date_display)}</span>
          <span class="evmain"><b>${esc(ev.name)}<span class="evhdr-live">${live ? " " + LIVE_BADGE : ""}</span>${ev.has_recap ? ' <span class="pill evpill">recap</span>' : ""}</b><span class="evloc">${esc(ev.location || "")}</span></span>
          <span class="evwin">${off ? (KIND_PILL[ev.kind] || KIND_PILL.special) : live ? "" : ev.future ? '<span class="pill">upcoming</span>' : winner ? h`${esc(winner.corps)}<b>${score3(winner.score)}</b>` : ""}</span>
          <span class="caret">▸</span>
        </button>
        <div class="evbody" hidden></div>
      </div>`;
    }
    const sectionBtn = (sec, label, open) =>
      `<button type="button" class="tab evsection" data-sec="${sec}">${esc(label)} ${open ? "▴" : "▾"}</button>`;

    function render() {
      const cls = fClsVal;
      const q = document.getElementById("fQ").value.trim().toLowerCase();
      const matched = events.map((ev, i) => [ev, i]).filter(([ev]) => matches(ev, cls, q));
      const filtering = !!(cls || corpsPick.size || q);
      const isCurrentYear = +year === new Date().getFullYear();
      const today = LIVE.today() || new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
      // a show is "finished" once its day is past, or (today) once it has results
      // and is no longer live — those drop to the results section below
      const finished = ([ev]) => ev.date < today || (ev.date === today && !ev.future && !LIVE.showLive(ev));

      const cnt = document.getElementById("evcount");
      let html;
      if (filtering || !isCurrentYear) {
        // filtered / past-season browse: a single flat list, newest first
        const sorted = matched.slice().sort(([a], [b]) =>
          (b.date || "").localeCompare(a.date || "") || a.name.localeCompare(b.name));
        html = sorted.map(rowHtml).join("");
        cnt.textContent = filtering ? `${matched.length} of ${events.length} events match` : "";
      } else {
        // the "what's on" view: the next show-day up front, then a tap-to-open
        // stack of the rest of the upcoming shows, then recent results right
        // beneath them (so last night's scores are one glance away), then the
        // rest of the season behind one more button.
        const unfinished = matched.filter(e => !finished(e))
          .sort(([a], [b]) => (a.date || "").localeCompare(b.date || ""));
        const past = matched.filter(finished)
          .sort(([a], [b]) => (b.date || "").localeCompare(a.date || ""));
        const curDate = unfinished.length ? unfinished[0][0].date : null;
        const current = unfinished.filter(([ev]) => ev.date === curDate);
        const upcoming = unfinished.filter(([ev]) => ev.date !== curDate);
        const recent = past.slice(0, 2), older = past.slice(2);
        const plur = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
        html =
          (current.length ? current.map(rowHtml).join("")
            : `<div class="evdone">No upcoming shows — the season's a wrap.</div>`) +
          (upcoming.length ? sectionBtn("up", `${plur(upcoming.length, "more upcoming event")}`, upOpen)
            + (upOpen ? upcoming.map(rowHtml).join("") : "") : "") +
          (recent.length ? `<div class="evsectlabel">Recent results</div>` + recent.map(rowHtml).join("") : "") +
          (older.length ? sectionBtn("past", `${plur(older.length, "earlier show")}`, pastOpen)
            + (pastOpen ? older.map(rowHtml).join("") : "") : "");
        cnt.textContent = "";
      }
      list.innerHTML = html || "<div class='card'><div class='empty'>No events match those filters.</div></div>";
      list.querySelectorAll(".evsection").forEach(b => b.onclick = () => {
        if (b.dataset.sec === "up") upOpen = !upOpen; else pastOpen = !pastOpen;
        render();
      });
      list.querySelectorAll(".evrow").forEach(row => {
        row.querySelector(".evhead").onclick = () => toggle(row);
      });
      if (allOpen) list.querySelectorAll(".evrow").forEach(row => toggle(row, true));
    }

    let allOpen = false;
    let upOpen = false, pastOpen = false;
    // filters survive tab switches for the session
    let savedF = {};
    try { savedF = JSON.parse(sessionStorage.getItem(NS("cad-shows-f")) || "{}"); } catch (e) {}
    const corpsPick = new Set();
    let fClsVal = clsList.includes(savedF.cls) ? savedF.cls : "";
    const fQEl = document.getElementById("fQ");
    if (savedF.q) fQEl.value = savedF.q;
    const persistF = () => {
      try {
        sessionStorage.setItem(NS("cad-shows-f"),
          JSON.stringify({ cls: fClsVal, corps: [...corpsPick], q: fQEl.value || "" }));
      } catch (e) {}
    };
    singleSelect(document.getElementById("fCls"), {
      label: "All classes",
      options: [{ value: "", label: "All classes" }, ...clsList.map(c => ({ value: c, label: c }))],
      value: fClsVal,
      onChange: v => { fClsVal = v || ""; persistF(); allOpen = false; syncToggle(); render(); },
    });
    fQEl.addEventListener("input", () => { persistF(); allOpen = false; syncToggle(); render(); });
    // corps picker: see just one corps' summer (favorites are one tap away)
    const seasonCorps = [...new Set(events.flatMap(ev => [
      ...(ev.lineup || []),
      ...(ev.classes || []).flatMap(c => (c.results || []).map(r => r.corps)),
    ]))].sort();
    (savedF.corps || []).filter(c => seasonCorps.includes(c)).forEach(c => corpsPick.add(c));
    multiSelect(document.getElementById("fCorps"), {
      label: "All " + TERM.plural, searchable: seasonCorps.length > 12, bulk: true, bulkAll: false,
      presets: FAVS.list().length ? [{ label: "★ Favorites", values: () => FAVS.list().filter(c => seasonCorps.includes(c)) }] : [],
      options: seasonCorps.map(c => ({ value: c, label: c })),
      selected: corpsPick,
      onChange: () => { persistF(); allOpen = false; syncToggle(); render(); },
    });
    const toggleBtn = document.getElementById("toggleAll");
    function syncToggle() { toggleBtn.textContent = allOpen ? "Collapse all ▴" : "Expand all ▾"; }
    toggleBtn.onclick = () => {
      allOpen = !allOpen;
      upOpen = pastOpen = allOpen; // reveal (or hide) every section too
      render();                    // repaint reveals the sections; render opens the bodies when allOpen
      if (!allOpen) list.querySelectorAll(".evrow").forEach(r => toggle(r, false));
      syncToggle();
    };
    // filters collapse behind a toggle — default is just the show list
    const fPanel = document.getElementById("fPanel");
    const fToggleBtn = document.getElementById("fToggle");
    const anyFilter = () => !!(fClsVal || corpsPick.size || (fQEl.value || "").trim());
    function syncFilterBtn() {
      fToggleBtn.setAttribute("aria-expanded", String(!fPanel.hidden));
      fToggleBtn.textContent = (anyFilter() ? "Filters ● " : "Filters ") + (fPanel.hidden ? "▾" : "▴");
    }
    fToggleBtn.onclick = () => { fPanel.hidden = !fPanel.hidden; syncFilterBtn(); };
    if (anyFilter()) fPanel.hidden = false; // reveal it so an active filter isn't a mystery
    syncFilterBtn();
    render();

    // Live running-order tracker: while a show runs today, keep the LIVE pills
    // in any open schedule current — the badge walks down the running order as
    // each corps takes the field. Repaints only the schedule rows (leaving the
    // rest of the card untouched) and only when the performing set changes.
    // Self-stops once the Shows view is torn down.
    const todayET = LIVE.today() || new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    if (events.some(e => Array.isArray(e.schedule) && e.schedule.length && e.date === todayET)) {
      const tick = setInterval(async () => {
        if (stale() || !document.body.contains(list)) { clearInterval(tick); return; }
        await LIVE.refresh(true).catch(() => {});
        // keep every row's header LIVE badge honest (drops when a show completes),
        // and repaint any open running order so the pills track the clock
        list.querySelectorAll(".evrow").forEach(row => {
          const ev = events[+row.dataset.i]; if (!ev) return;
          const on = LIVE.showLive(ev);
          const hdr = row.querySelector(".evhdr-live");
          if (hdr) hdr.innerHTML = on ? " " + LIVE_BADGE : "";
          row.classList.toggle("evlive", on);
          const tb = row.querySelector("tbody.evsched");
          if (tb && !row.querySelector(".evbody").hidden) tb.innerHTML = scheduleRowsHtml(ev);
        });
      }, 30000);
    }
  }

  /* ===== judge-level recap sheets =====
     The official sheet at full fidelity: every judge's sub-scores with the
     sheet's own per-caption ranks. recaps/<year>.json is built straight from
     the published header hierarchy — nothing here is derived. */
  async function recapEvent(year, evName, evDate) {
    if (+year < 2013) return null; // sheets only exist for the DCI.org era
    let rec;
    try { rec = await data(`recaps/${year}.json`); } catch (e) { return null; }
    return (rec.events || []).find(e => e.e === evName && (!evDate || e.d === evDate)) || null;
  }

  /* ===== "Caption Winners Card" call-to-action =====
     The shareable card is the best thing in the captions data, so it gets a
     loud, obvious entry point — the same treatment the corps page gives its
     season card — at the TOP of every captions block. */
  const CAP_CTA_INNER =
    `<span class="capcta-ic">${icoSvg(ICO_TROPHY, 23)}</span>` +
    '<span class="capcta-t"><b>Caption Winners Card</b>' +
    "<span>See who took GE · Visual · Music — and by how much</span></span>" +
    '<span class="capcta-go">Open →</span>';
  const capCta = (attrs = "") => `<button type="button" class="capcta"${attrs}>${CAP_CTA_INNER}</button>`;
  // `info` may be a function so the button can read the currently-picked show
  function wireCapCta(btn, info) {
    if (!btn) return;
    const note = msg => `<span class="capcta-ic">${icoSvg(ICO_TROPHY, 23)}</span><span class="capcta-t"><b>${esc(msg)}</b></span>`;
    btn.onclick = () => {
      if (!window.CadWrapped || !window.CadWrapped.captionsCard) return;
      const i = typeof info === "function" ? info() : info;
      if (!i) return;
      btn.disabled = true;
      btn.innerHTML = note("Creating card…");
      const restore = () => { btn.disabled = false; btn.innerHTML = CAP_CTA_INNER; };
      window.CadWrapped.captionsCard(i).then(ok => {
        if (ok) return restore();
        btn.disabled = false;
        btn.innerHTML = note("No caption sheet for this show yet");
        setTimeout(() => { if (btn.isConnected) restore(); }, 1900);
      }).catch(restore);
    };
  }

  // Hierarchical sheet: caption group → judge sub-caption → sub-scores.
  // Rank sits under every value; gold marks each column's leader. Tap a
  // caption, judge, or column header to re-rank the sheet by it.
  function renderRecapSheet(host, cd, opts = {}) {
    const cols = [];   // flat column meta; index i addresses vals[i] / ranks[i]
    const groups = [];
    for (const g of cd.groups) {
      const gm = { n: g.n, subs: [], first: cols.length };
      for (const s of g.subs) {
        const sm = { n: s.n, j: s.j, first: cols.length };
        for (const cl of s.cols) cols.push({ label: cl, kind: "c" });
        sm.totI = cols.length;
        cols.push({ label: "Tot", kind: "st" });
        gm.subs.push(sm);
      }
      gm.totI = cols.length;
      cols.push({ label: "Tot", kind: "gt" });
      gm.span = cols.length - gm.first;
      groups.push(gm);
    }
    const iSub = cols.length; cols.push({ label: "Sub", kind: "sub" });
    const iPen = cols.length; cols.push({ label: "Pen", kind: "pen" });
    const iTot = cols.length; cols.push({ label: "Total", kind: "tot" });

    // who won each caption — the sheet's headline, stated plainly.
    // Always computed over the FULL sheet, not the filtered view.
    const shortSub = n => n.replace(/^General Effect/, "GE")
      .replace(/^Visual\s*[-–]\s*/, "Visual ").replace(/^Music\s*[-–]\s*Analysis/, "Music Analysis")
      .replace(/^Music\s*[-–]\s*/, "");
    const winnerOf = i => {
      let hi = -1, names = [];
      for (const r of cd.rows) {
        const v = r[1][i];
        if (v == null) continue;
        if (v > hi) { hi = v; names = [r[0]]; }
        else if (v === hi && !names.includes(r[0])) names.push(r[0]);
      }
      return hi > 0 ? names.join(" & ") : null;
    };
    const winChips = [];
    for (const g of groups) {
      const w = winnerOf(g.totI);
      if (w) winChips.push(`<span class="cw-main"><b>${esc(g.n)}</b> ${esc(w)}</span>`);
      for (const s of g.subs) {
        const ws = winnerOf(s.totI);
        if (ws) winChips.push(`<span><b>${esc(shortSub(s.n))}</b> ${esc(ws)}</span>`);
      }
    }
    const winStrip = winChips.length
      ? `<div class="capwins" title="Caption winners on this sheet"><span class="cw-ico">${icoSvg(ICO_TROPHY, 14)}</span>${winChips.join("")}</div>` : "";
    // heavier rule where a caption group starts, so the blocks read at a glance
    const gb = new Set(groups.map(g => g.first));
    gb.add(iSub);
    let sortI = iTot;

    const fmt = (v, kind) => v == null ? "—"
      : kind === "c" || kind === "st" ? (+v).toFixed(2)
      : kind === "pen" ? (+v ? (+v).toFixed(2) : "—")
      : (+v).toFixed(3);

    function paint() {
      let rows = cd.rows;
      if (opts.pick && opts.pick.size) rows = rows.filter(r => opts.pick.has(r[0]));
      rows = rows.slice().sort((a, b) => (b[1][sortI] ?? -1) - (a[1][sortI] ?? -1));
      const best = cols.map((c, i) => c.kind === "pen" ? null
        : Math.max(...rows.map(r => (r[1][i] == null ? -1 : r[1][i]))));
      // quick-jump chips: the sheet is wide, so hop straight to a caption block
      const chips = `<div class="rjump">${groups.map((g, gi) =>
        `<button type="button" class="rjbtn" data-g="${gi}">${esc(g.n)}</button>`).join("")}<button type="button" class="rjbtn" data-g="end">Totals</button></div>`;
      host.innerHTML = `${winStrip}${chips}<div class="tscroll"><table class="t sticky1 rt"><thead>
        <tr><th rowspan="3">${TERM_TH}</th>${groups.map(g =>
          `<th colspan="${g.span}" class="rgrp gb" data-c="${g.totI}">${esc(g.n)}</th>`).join("")}<th rowspan="3" class="num gb" data-c="${iSub}">Sub</th><th rowspan="3" class="num" data-c="${iPen}">Pen</th><th rowspan="3" class="num" data-c="${iTot}">Total</th></tr>
        <tr>${groups.map(g => g.subs.map(s =>
          `<th colspan="${s.totI - s.first + 1}" class="rsub${s.first === g.first ? " gb" : ""}" data-c="${s.totI}">${esc(s.n)}${s.j && s.j !== "." ? `<small>${esc(s.j)}</small>` : ""}</th>`).join("") +
          `<th rowspan="2" class="num${g.subs.length ? "" : " gb"}" data-c="${g.totI}">Tot</th>`).join("")}</tr>
        <tr>${groups.map(g => g.subs.map(s =>
          cols.slice(s.first, s.totI).map((c, k) =>
            `<th class="num${s.first + k === g.first ? " gb" : ""}" data-c="${s.first + k}">${esc(c.label)}</th>`).join("") +
          `<th class="num" data-c="${s.totI}">Tot</th>`).join("")).join("")}</tr>
        </thead><tbody>
        ${rows.map(r => `<tr><td>${corpsLink(r[0])}</td>${cols.map((c, i) => {
          const v = r[1][i], rk = r[2][i];
          const win = c.kind !== "pen" && v != null && v === best[i] && best[i] > 0;
          return `<td class="num${win ? " capwin" : ""}${gb.has(i) ? " gb" : ""}"><b>${fmt(v, c.kind)}</b><i>${rk == null ? "" : rk}</i></td>`;
        }).join("")}</tr>`).join("")}
        </tbody></table></div>`;
      host.querySelectorAll("th[data-c]").forEach(th => {
        if (+th.dataset.c === sortI) th.classList.add("on");
        th.onclick = () => { sortI = +th.dataset.c; paint(); };
      });
      const sc = host.querySelector(".tscroll");
      host.querySelectorAll(".rjbtn").forEach(bt => bt.onclick = () => {
        const firstTd = sc.querySelector("tbody td:first-child");
        const stickyW = firstTd ? firstTd.offsetWidth : 120;
        if (bt.dataset.g === "end") {
          sc.scrollTo({ left: sc.scrollWidth, behavior: "smooth" });
          return;
        }
        const th = sc.querySelectorAll("th.rgrp")[+bt.dataset.g];
        if (th) sc.scrollTo({ left: Math.max(0, th.offsetLeft - stickyW - 6), behavior: "smooth" });
      });
    }
    paint();
    return { repaint: paint };
  }

  async function viewEvent(year, idx, stale, qs) {
    setNav("events");
    // ?c=<corps> — set by score-alert deep links: emphasize that corps' row
    // and bring it into view so a tapped notification lands on the result
    const focus = (() => { try { return new URLSearchParams(qs || "").get("c") || ""; } catch (e) { return ""; } })();
    const events = await data(`seasons/${year}.json`);
    if (stale()) return;
    const ev = events[+idx];
    if (!ev) { app.innerHTML = "<div class='empty'>Event not found.</div>"; return; }

    // judge-level recap when available; verified caption summary as fallback
    // (recaps only exist for the DCI.org era — skip the fetch for old years)
    let capRows = [];
    let recEv = null;
    try {
      if (+year >= 2013 && CAPS) {
        recEv = await recapEvent(year, ev.name, ev.date);
        const all = await data(`captions/${year}.json`);
        capRows = all.filter(r => r[1] === ev.name && (!ev.date || r[0] === ev.date));
      }
    } catch (e) { /* captions not built for this season */ }
    if (stale()) return; // bail whether the captions fetch succeeded or not
    const recByClass = new Map(((recEv && recEv.classes) || []).map(c => [c.c, c]));
    const capByClass = new Map();
    capRows.forEach(r => {
      const arr = capByClass.get(r[2]) || [];
      arr.push(r);
      capByClass.set(r[2], arr);
    });
    const CAP_HEAD = [["ge", "GE"], ["vp", "VP"], ["va", "VA"], ["cg", "CG"], ["br", "BR"], ["ma", "MA"], ["pc", "PC"], ["tot", "Total"]];
    const CIDX = { date: 0, event: 1, cls: 2, corps: 3, ge1: 4, ge2: 5, ge: 6, vp: 7, va: 8, cg: 9, vis: 10, br: 11, ma: 12, pc: 13, mus: 14, pen: 15, tot: 16 };
    const capTable = (cls, ci) => {
      const rows = (capByClass.get(cls) || []).slice().sort((a, b) => b[CIDX.tot] - a[CIDX.tot]);
      if (!rows.length) return "";
      // gold on each caption's best so the winner reads at a glance
      const best = {};
      CAP_HEAD.forEach(([k]) => { best[k] = Math.max(...rows.map(r => r[CIDX[k]] == null ? -1 : r[CIDX[k]])); });
      const FLAT_WINS = [["ge", "GE"], ["vp", "Visual Prof."], ["va", "Visual Analysis"], ["cg", "Color Guard"], ["br", "Brass"], ["ma", "Music Analysis"], ["pc", "Percussion"]];
      const winChips = FLAT_WINS.map(([k, label]) => {
        const names = rows.filter(r => r[CIDX[k]] != null && r[CIDX[k]] === best[k] && best[k] > 0).map(r => r[CIDX.corps]);
        return names.length ? `<span${k === "ge" ? ' class="cw-main"' : ""}><b>${esc(label)}</b> ${esc([...new Set(names)].join(" & "))}</span>` : "";
      }).join("");
      return h`<h3 class="evcls" style="margin-top:14px">Caption Breakdown <span class="kicker">verified against the official recap · gold marks the caption winner · tap a column to sort</span></h3>
        ${winChips ? `<div class="capwins"><span class="cw-ico">${icoSvg(ICO_TROPHY, 14)}</span>${winChips}</div>` : ""}
        <div class="tscroll"><table class="t sticky1 capsort"><thead><tr><th>${TERM_TH}</th>${CAP_HEAD.map(([k, l]) => `<th class="num" data-sort="${k}">${l}</th>`).join("")}</tr></thead><tbody class="evcap" data-ci="${ci}">
        ${rows.map(r => `<tr><td>${corpsLink(r[CIDX.corps])}</td>${CAP_HEAD.map(([k]) => {
          const v = r[CIDX[k]];
          const win = v != null && v === best[k] && best[k] > 0;
          return `<td class="num${k === "tot" ? " score" : ""}${win ? " capwin" : ""}">${v == null ? "—" : (+v).toFixed(k === "tot" ? 3 : 2)}</td>`;
        }).join("")}</tr>`).join("")}
        </tbody></table></div>${CAP_KEY_NOTE}`;
    };
    // the full official sheet beats the summary — show it whenever it parsed.
    // The shareable card leads the block so it's the first thing you see.
    const capSection = (cls, ci) => {
      const sheet = recByClass.has(cls)
        ? h`<h3 class="evcls" style="margin-top:14px">Official Recap <span class="kicker">every judge, every caption · rank under each score · gold marks the leader · tap a judge or column to sort</span></h3>
           <div class="rcmount" data-cls="${esc(cls)}"></div>`
        : capTable(cls, ci);
      if (!sheet) return "";
      return `<div class="capctawrap">${capCta(` data-cls="${esc(cls)}"`)}</div>` + sheet;
    };

    app.innerHTML = h`
      <div class="crumbs"><a href="#/events?y=${year}">Shows</a> / <a href="#/events?y=${year}">${year}</a> / ${esc(ev.name)}</div>
      <h1 class="page">${esc(ev.name)}</h1>
      <p class="lede">${esc(fmtDateY(ev.date) || ev.date_display || "")}${ev.location ? " · " + esc(ev.location) : ""}${ev.url ? h` · <a href="${encodeURI(ev.url)}" target="_blank" rel="noopener">source ↗</a>` : ""}</p>
      <button id="evShare" class="favtoggle" style="margin:0 0 12px" title="Share this show">${SHARE_SVG} Share</button>
      ${(ev.classes || []).map((c, ci) => h`
        <div class="card cardgap"><h2>${esc(c.label || c.class)}</h2>
        <div class="tscroll"><table class="t"><thead><tr><th>#</th><th>${TERM_TH}</th><th class="num">Score</th></tr></thead><tbody class="evres" data-ci="${ci}">
        ${c.results.map(r => `<tr${FAVS.has(r.corps) || r.corps === focus ? ` class="favrow"${r.corps === focus ? ' data-focus="1"' : ""}` : ""}><td class="rank">${r.place ?? "—"}</td><td>${corpsLink(r.corps)}</td><td class="num score">${score3(r.score)}</td></tr>`).join("")}
        </tbody></table></div>
        ${capSection(c.class, ci)}</div>`).join("")}
      ${ev.recap_url ? `<p style="font-size:12.5px;color:var(--muted)"><a href="${encodeURI(ev.recap_url)}" target="_blank" rel="noopener">Official recap on DCI.org ↗</a></p>` : ""}
      ${ev.location ? `<p style="font-size:12.5px;color:var(--muted)"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((ev.name || "") + " " + ev.location)}" target="_blank" rel="noopener">Venue map ↗</a></p>` : ""}`;
    wireShare("evShare", `${ev.name} · Cadence`);
    document.querySelectorAll(".capcta").forEach(btn => wireCapCta(btn,
      () => ({ year: +year, date: ev.date, event: ev.name, cls: btn.dataset.cls })));
    document.querySelectorAll(".rcmount").forEach(m => {
      const rc = recByClass.get(m.dataset.cls);
      if (rc) renderRecapSheet(m, rc);
    });
    document.querySelectorAll(".evres, .evcap").forEach(tb => collapseRows(tb, 5, TERM.plural));
    // deep-linked corps: expand its table if the collapse hid it, then bring
    // the row into view (instant — no animation to fight reduced-motion)
    const focusRow = focus && document.querySelector('tr[data-focus="1"]');
    if (focusRow) {
      if (focusRow.classList.contains("hid")) {
        const wrap = (focusRow.closest(".tscroll") || {}).nextElementSibling;
        const btn = wrap && wrap.querySelector && wrap.querySelector("button");
        if (btn) btn.click();
      }
      setTimeout(() => { try { focusRow.scrollIntoView({ block: "center" }); } catch (e) {} }, 60);
    }
    // tap a caption header to re-rank the sheet by that caption
    document.querySelectorAll(".capsort").forEach(table => {
      table.querySelectorAll("th[data-sort]").forEach(th => th.onclick = () => {
        const k = th.dataset.sort;
        const tb = table.tBodies[0];
        const rowsArr = [...tb.rows];
        const idx = [...table.tHead.rows[0].cells].indexOf(th);
        rowsArr.sort((a, b) => {
          const av = parseFloat(a.cells[idx].textContent) || -1;
          const bv = parseFloat(b.cells[idx].textContent) || -1;
          return bv - av;
        });
        rowsArr.forEach(r => tb.appendChild(r));
        rowsArr.forEach(r => r.classList.remove("hid"));
        const wrap = (tb.closest(".tscroll") || {}).nextElementSibling;
        if (wrap && wrap.classList && wrap.classList.contains("expandwrap")) wrap.remove();
      });
    });
  }

  /* ============ CAPTIONS ============ */
  const CAPTION_DEFS = [
    ["ge", "General Effect"], ["ge1", "GE 1"], ["ge2", "GE 2"],
    ["vis", "Visual"], ["vp", "Visual Proficiency"], ["va", "Visual Analysis"], ["cg", "Color Guard"],
    ["mus", "Music"], ["br", "Brass"], ["ma", "Music Analysis"], ["pc", "Percussion"],
    ["tot", "Total"],
  ];

  async function viewCaptions(qs, stale) {
    setNav("data");
    let cindex;
    try { cindex = await data("captions/index.json"); }
    catch (e) {
      if (!stale()) app.innerHTML = "<div class='card'><div class='empty'>Caption data builds with the next data run.</div></div>";
      return;
    }
    if (stale()) return;
    const cols = cindex.cols;
    const seasons = cindex.seasons.map(s => s.year).sort((a, b) => b - a);
    const params = parseHashQuery(qs);
    let year = +params.y && seasons.includes(+params.y) ? +params.y : seasons[0];
    let capKey = CAPTION_DEFS.some(([k]) => k === params.cap) ? params.cap : "ge";
    let spotWant = params.corps ? decodeURIComponent(params.corps) : null; // deep link into the Spotlight

    app.innerHTML = `
      ${dataSubNav("captions")}
      <h1 class="page">Caption Scores</h1>
      <div class="card">
        <h2 id="showCmpTitle">Show Recap <span class="sub">the official judge-by-judge sheet — rank under each score, gold marks each caption's leader</span></h2>
        <div class="filters" style="margin:2px 0 8px"><div id="showSel"></div><div id="showCorpsSel"></div></div>
        <div class="capctawrap">${capCta(' id="showCapCta"')}</div>
        <div id="showCmpBody"><div class="empty">Pick a show above.</div></div>
      </div>
      <div class="secdiv" id="capSeasonDiv"></div>
      <div class="filters">
        <div id="capYear"></div>
        <div id="capKey"></div>
        <div id="capCls"></div>
      </div>
      <div class="dsk2 w75" style="margin-top:14px">
        <div class="card">
          <h2 id="capChartTitle"></h2>
          <div class="filters" style="margin:2px 0 8px"><div id="capCorpsSel"></div><button class="tab" id="capReset" hidden>Top 8</button></div>
          <div class="chartwrap" id="capChart"></div>
        </div>
        <div class="card">
          <h2 id="capBoardTitle"></h2>
          <div id="capBoard"></div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <h2 id="spotTitle">Corps Spotlight</h2>
        <div class="filters" style="margin:2px 0 8px"><div id="spotCorps"></div><div id="spotVs"></div></div>
        <div class="chartwrap" id="spotChart"></div>
        ${CAP_KEY_NOTE}
      </div>
      <div class="secdiv">All-Time</div>
      <div class="card">
        <h2 id="titlesTitle">Caption Titles</h2>
        <div class="filters" style="margin:2px 0 8px">
          <div id="titlesCaps"></div>
          <button class="tab" id="titlesMode">Career totals</button>
        </div>
        <div id="titlesBody"><div class="loading">Loading…</div></div>
        ${CAP_KEY_NOTE}
        <p class="capkey">* one or more recap rows for that night couldn't be fully verified — the winner shown leads among verified scores</p>
      </div>`;


    // the card follows whatever show + class is picked above it
    wireCapCta(document.getElementById("showCapCta"), () => {
      const v = ssShow && ssShow.get();
      if (!v) return null;
      const [d, evName] = String(v).split("|");
      return { year, date: d, event: evName, cls };
    });

    let rows = [];
    let recapsYr = []; // judge-level sheets for the picked year
    let cls = "";
    let loadGen = 0; // guards against out-of-order season loads
    const capPick = new Set();
    let seedPick = true; // (re)fill the picker with the top 12 on next update
    let msCap = null;
    let lastBoard = [];
    const capIsDefault = () => capPick.size === Math.min(12, lastBoard.length)
      && lastBoard.slice(0, 12).every(b => capPick.has(b.corps));

    const iDate = () => cols.indexOf("date"), iEv = () => cols.indexOf("event"),
      iCls = () => cols.indexOf("class"), iCorps = () => cols.indexOf("corps");

    function classesIn(rs) { return sortClasses([...new Set(rs.map(r => r[iCls()]))]); }

    // --- show recap sheet: one show, all corps, judge by judge ---
    let ssShow = null;
    let msShowCorps = null;
    const showPick = new Set();
    let showPickKey = ""; // reseed the corps filter when the show changes
    let showCorpsN = 0;   // sheet size backing the "All corps" summary
    function renderShowCmp() {
      const body = document.getElementById("showCmpBody");
      if (!body) return;
      const shows = [];
      const seen = new Set();
      const judged = new Set(); // shows with a full judge-level sheet
      for (const e of recapsYr) {
        if (!e.d || !(e.classes || []).some(c => c.c === cls)) continue;
        const key = e.d + "|" + e.e;
        judged.add(key);
        if (!seen.has(key)) { seen.add(key); shows.push({ d: e.d, ev: e.e }); }
      }
      for (const r of rows) {
        if (r[iCls()] !== cls || !r[iDate()]) continue;
        const key = r[iDate()] + "|" + r[iEv()];
        if (!seen.has(key)) { seen.add(key); shows.push({ d: r[iDate()], ev: r[iEv()] }); }
      }
      shows.sort((a, b) => b.d.localeCompare(a.d));
      const corpsSel = document.getElementById("showCorpsSel");
      const ctaWrap = document.querySelector("#showCapCta") && document.querySelector("#showCapCta").parentElement;
      if (ctaWrap) ctaWrap.hidden = !shows.length; // nothing to card up without a sheet
      if (!shows.length) {
        body.innerHTML = "<div class='empty'>No verified recaps for this class yet.</div>";
        if (ssShow) ssShow.setOptions([]);
        if (corpsSel) corpsSel.style.display = "none";
        return;
      }
      const opts = shows.map(sh => ({ value: sh.d + "|" + sh.ev, label: sh.ev, hint: fmtDateY(sh.d) }));
      if (!ssShow) {
        ssShow = singleSelect(document.getElementById("showSel"), {
          label: "Pick a show…", searchable: shows.length > 6, searchHint: true,
          options: opts, value: opts[0].value,
          onChange: renderShowCmp,
        });
      } else {
        ssShow.setOptions(opts);
        if (!opts.some(o => o.value === ssShow.get())) ssShow.set(opts[0].value);
      }
      const [d, evName] = String(ssShow.get()).split("|");

      // full judge-level sheet when the official recap parsed
      const rev = recapsYr.find(e => e.d === d && e.e === evName);
      const rc = rev && (rev.classes || []).find(c => c.c === cls);
      if (rc) {
        const names = rc.rows.map(r => r[0]);
        showCorpsN = names.length;
        const key = d + "|" + evName + "|" + cls;
        if (showPickKey !== key) {
          showPickKey = key;
          showPick.clear();
          names.forEach(n => showPick.add(n));
        }
        const corpsOpts = names.map(n => ({ value: n, label: n }));
        if (corpsSel) {
          corpsSel.style.display = "";
          if (!msShowCorps) {
            msShowCorps = multiSelect(corpsSel, {
              label: "All " + TERM.plural, bulk: true,
              summary: () => !showPick.size || showPick.size === showCorpsN ? "All corps" : null,
              options: corpsOpts, selected: showPick,
              onChange: renderShowCmp,
            });
          } else {
            msShowCorps.setOptions(corpsOpts);
          }
        }
        body.innerHTML = "";
        const mount = document.createElement("div");
        body.appendChild(mount);
        renderRecapSheet(mount, rc, { pick: showPick });
        const foot = document.createElement("p");
        foot.className = "capkey";
        foot.style.marginTop = "8px";
        foot.textContent = `${evName} · ${fmtDateY(d)} · ${rc.rows.length} corps · rank under each score · tap a caption, judge, or column to sort`;
        body.appendChild(foot);
        return;
      }
      if (corpsSel) corpsSel.style.display = "none";

      // fallback: reconciled caption totals (older sheets the parser passed on)
      const iTot = cols.indexOf("tot");
      const sheet = rows.filter(r => r[iCls()] === cls && r[iDate()] === d && r[iEv()] === evName)
        .sort((a, b) => (b[iTot] || 0) - (a[iTot] || 0));
      const HEAD = [["ge1", "GE1"], ["ge2", "GE2"], ["ge", "GE"], ["vp", "VP"], ["va", "VA"], ["cg", "CG"], ["vis", "VIS"],
        ["br", "BR"], ["ma", "MA"], ["pc", "PC"], ["mus", "MUS"], ["pen", "Pen"], ["tot", "Total"]];
      // the best value in each caption wins the gold cell (penalty: no winner)
      const best = {};
      for (const [k] of HEAD) {
        if (k === "pen") continue;
        const i = cols.indexOf(k);
        best[k] = Math.max(...sheet.map(r => r[i] == null ? -1 : r[i]));
      }
      const FLAT_WINS = [["ge", "GE"], ["vp", "Visual Prof."], ["va", "Visual Analysis"], ["cg", "Color Guard"], ["br", "Brass"], ["ma", "Music Analysis"], ["pc", "Percussion"]];
      const winChips = FLAT_WINS.map(([k, label]) => {
        const i = cols.indexOf(k);
        const names = [...new Set(sheet.filter(r => r[i] != null && r[i] === best[k] && best[k] > 0).map(r => r[iCorps()]))];
        return names.length ? `<span${k === "ge" ? ' class="cw-main"' : ""}><b>${esc(label)}</b> ${esc(names.join(" & "))}</span>` : "";
      }).join("");
      body.innerHTML = `${winChips ? `<div class="capwins"><span class="cw-ico">${icoSvg(ICO_TROPHY, 14)}</span>${winChips}</div>` : ""}<div class="tscroll"><table class="t sticky1 showcmp"><thead><tr><th>${TERM_TH}</th>${HEAD.map(([k, l]) =>
          `<th class="num" data-c="${cols.indexOf(k)}">${l}</th>`).join("")}</tr></thead><tbody>
        ${sheet.map(r => `<tr><td>${corpsLink(r[iCorps()])}</td>${HEAD.map(([k]) => {
          const i = cols.indexOf(k);
          const v = r[i];
          const win = k !== "pen" && v != null && v === best[k] && best[k] >= 0;
          return `<td class="num${k === "tot" ? " score" : ""}${win ? " capwin" : ""}">${v == null ? "—" : (+v).toFixed(k === "tot" ? 3 : 2)}</td>`;
        }).join("")}</tr>`).join("")}
      </tbody></table></div>
      <p class="capkey" style="margin-top:8px">${esc(evName)} · ${esc(fmtDateY(d))} · ${sheet.length} corps · tap a column to sort</p>${CAP_KEY_NOTE}`;
      body.querySelectorAll("th[data-c]").forEach(th => th.onclick = () => {
        const i = +th.dataset.c;
        const tb = body.querySelector("tbody");
        [...tb.rows].sort((a, b) => {
          const idx = [...th.parentNode.children].indexOf(th);
          return (parseFloat(b.cells[idx].textContent) || -1) - (parseFloat(a.cells[idx].textContent) || -1);
        }).forEach(rw => tb.appendChild(rw));
      });
    }

    let ssCls = null;
    function renderClassTabs() {
      const cl = classesIn(rows);
      const opts = cl.map(c => ({ value: c, label: c }));
      if (!ssCls) {
        ssCls = singleSelect(document.getElementById("capCls"), {
          label: "Class", options: opts, value: cls,
          onChange: v => { cls = v; seedPick = true; update(); renderTitles(); },
        });
      } else {
        ssCls.setOptions(opts);
        ssCls.set(cls);
      }
    }

    function corpsSeries() {
      const ki = cols.indexOf(capKey);
      const per = new Map();
      for (const r of rows) {
        if (r[iCls()] !== cls || r[ki] == null || !r[iDate()]) continue;
        const arr = per.get(r[iCorps()]) || [];
        arr.push({ d: r[iDate()], ev: r[iEv()], v: r[ki] });
        per.set(r[iCorps()], arr);
      }
      per.forEach(a => a.sort((x, y) => x.d.localeCompare(y.d)));
      return per;
    }

    function update() {
      renderClassTabs();
      const per = corpsSeries();
      const label = (CAPTION_DEFS.find(([k]) => k === capKey) || [])[1];
      const board = [...per.entries()].map(([corps, a]) => {
        const best = a.reduce((m, p) => p.v > m.v ? p : m, a[0]);
        const last = a[a.length - 1];
        return { corps, best: best.v, bestEv: best.ev, bestD: best.d,
          latest: last.v, latestEv: last.ev, latestD: last.d, n: a.length };
      }).sort((x, y) => y.best - x.best);
      board.forEach((b, i) => { b.rank = i + 1; });

      // chart: top 12 pre-selected in the picker — deselect to trim
      if (seedPick) {
        capPick.clear();
        board.slice(0, 12).forEach(b => capPick.add(b.corps));
        seedPick = false;
      }
      lastBoard = board;
      const capDefault = capIsDefault();
      const chosen = board.filter(b => capPick.has(b.corps));
      const div = document.getElementById("capSeasonDiv");
      if (div) div.textContent = `${year} Season — Caption Scores`;
      document.getElementById("capChartTitle").innerHTML =
        `${esc(label)} Progression — ${esc(String(year))} <span class="sub">${capDefault ? "top 12" : chosen.length + " selected"}</span>`;
      document.getElementById("capReset").hidden = capDefault;
      document.getElementById("capReset").textContent = "Top 12";
      lineChart(document.getElementById("capChart"), {
        linearX: true,
        series: chosen.map(b => ({
          name: b.corps, color: corpsColor(b.corps),
          points: per.get(b.corps).map(p => ({ x: dayOfSeason(p.d), y: p.v })),
        })),
        height: 330, xFmt: dayLabel, yFmt: v => v.toFixed(1),
      });

      document.getElementById("capBoardTitle").innerHTML =
        `${esc(label)} Leaders — ${esc(String(year))} <span class="sub">best single-show score, ${esc(cls)}</span>`;
      document.getElementById("capBoard").innerHTML = board.length ? `
        <div class="tscroll"><table class="t"><thead><tr><th>#</th><th>${TERM_TH}</th><th class="num">Best</th><th>At</th><th class="num col-high">Latest</th><th class="num col-perfs">Scored shows</th></tr></thead><tbody>
        ${board.map(b => h`<tr>
          <td class="rank">${b.rank}</td>
          <td>${corpsLink(b.corps)}</td>
          <td class="num score">${score3(b.best)}</td>
          <td style="color:var(--muted);font-size:12.5px;white-space:nowrap">${esc(b.bestEv)} · ${esc(fmtDateY(b.bestD))}</td>
          <td class="num col-high" data-tip="${esc(`${score3(b.latest)} — ${b.latestEv} · ${fmtDateY(b.latestD)}`)}">${score3(b.latest)}</td>
          <td class="num col-perfs">${b.n}</td></tr>`).join("")}
        </tbody></table></div>` : "<div class='empty'>No recap data for this caption yet — it fills in as recaps are scraped.</div>";
      if (board.length) collapseRows(document.querySelector("#capBoard tbody"), 5, TERM.plural);

      renderSpot(board);
      renderShowCmp();

      // corps picker persists across updates so the panel stays open
      const capOptions = board.map(b => ({ value: b.corps, label: b.corps, hint: `#${b.rank}` }));
      if (!msCap) {
        msCap = multiSelect(document.getElementById("capCorpsSel"), {
          label: "Pick " + TERM.plural + " to chart…", searchable: true,
          summary: () => capIsDefault() ? "Top 12" : null,
          bulk: true, bulkAll: false,
          presets: [{ label: "Top 12", values: () => lastBoard.slice(0, 12).map(b => b.corps) }],
          options: capOptions,
          selected: capPick,
          onChange: update,
        });
        document.getElementById("capReset").onclick = () => { seedPick = true; msCap.refresh(); update(); };
      } else {
        msCap.setOptions(capOptions);
      }

      if (!stale()) history.replaceState(null, "", `#/captions?y=${year}&cap=${capKey}`);
    }

    // caption-by-caption bars for one corps: latest show vs season best
    const SPOT_CAPS = [["ge1", "GE1"], ["ge2", "GE2"], ["vp", "VP"], ["va", "VA"],
      ["cg", "CG"], ["br", "BR"], ["ma", "MA"], ["pc", "PC"]];
    let ssSpot = null;
    let ssVs = null;
    let spotBoard = [];
    function renderSpot(board) {
      if (!document.getElementById("spotCorps")) return;
      spotBoard = board;
      const opts = board.map(b => ({ value: b.corps, label: b.corps, hint: `#${b.rank}` }));
      const wantSpot = spotWant && board.some(b => b.corps === spotWant) ? spotWant : null;
      if (!ssSpot) {
        ssSpot = singleSelect(document.getElementById("spotCorps"), {
          label: "Pick " + TERM.a + "…", searchable: board.length > 12, options: opts,
          value: wantSpot || (board.length ? board[0].corps : null),
          onChange: () => renderSpot(spotBoard),
        });
      } else {
        ssSpot.setOptions(opts);
        if (wantSpot) ssSpot.set(wantSpot);
        else if (!board.some(b => b.corps === ssSpot.get())) ssSpot.set(board.length ? board[0].corps : null);
      }
      if (wantSpot) {
        spotWant = null; // consumed — user picks freely from here
        setTimeout(() => {
          const t = document.getElementById("spotTitle");
          if (t) t.scrollIntoView({ block: "start", behavior: "smooth" });
        }, 60);
      }
      const vsOpts = [{ value: "", label: "No comparison" }, ...opts];
      if (!ssVs) {
        ssVs = singleSelect(document.getElementById("spotVs"), {
          label: "Compare vs…", searchable: board.length > 12, options: vsOpts, value: "",
          onChange: () => renderSpot(spotBoard),
        });
      } else {
        ssVs.setOptions(vsOpts);
        if (ssVs.get() && !board.some(b => b.corps === ssVs.get())) ssVs.set("");
      }
      const corps = ssSpot.get();
      const chartEl = document.getElementById("spotChart");
      if (!corps) { chartEl.innerHTML = "<div class='empty'>No corps in this class yet.</div>"; return; }
      const vs = ssVs.get() && ssVs.get() !== corps ? ssVs.get() : "";

      const latestOf = name => {
        const perf = rows.filter(r => r[iCls()] === cls && r[iCorps()] === name && r[iDate()])
          .sort((a, b) => a[iDate()].localeCompare(b[iDate()]));
        return perf.length ? perf[perf.length - 1] : null;
      };
      const latest = latestOf(corps);
      if (!latest) { chartEl.innerHTML = "<div class='empty'>No verified recap for this corps yet.</div>"; return; }
      const vsLatest = vs ? latestOf(vs) : null;
      document.getElementById("spotTitle").innerHTML = vsLatest
        ? `${esc(corps)} vs ${esc(vs)} <span class="sub">latest recap of each · every caption out of 20</span>`
        : `${esc(corps)} — Caption Scores <span class="sub">${esc(latest[iEv()])} · ${esc(fmtDateY(latest[iDate()]))} · each caption out of 20</span>`;
      // per-caption rank within the class (by season best)
      const rankOf = (k, name) => {
        const ki = cols.indexOf(k);
        const bests = new Map();
        for (const r of rows) {
          if (r[iCls()] !== cls || r[ki] == null) continue;
          const cur = bests.get(r[iCorps()]);
          if (cur == null || r[ki] > cur) bests.set(r[iCorps()], r[ki]);
        }
        return [...bests.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]).indexOf(name) + 1;
      };
      const groups = SPOT_CAPS.map(([k, label]) => {
        const ki = cols.indexOf(k);
        const rA = rankOf(k, corps);
        const bars = [{ name: corps, value: latest[ki], color: corpsColor(corps) }];
        let sub = rA > 0 ? `#${rA}` : "";
        if (vsLatest) {
          const rB = rankOf(k, vs);
          bars.push({ name: vs, value: vsLatest[ki], color: corpsColor(vs) });
          sub = rA > 0 && rB > 0 ? `#${rA}·#${rB}` : sub;
        }
        return { label, sub, bars };
      });
      CCViz.barChart(chartEl, { groups, height: 280, yMax: 20, track: true, yFmt: v => v.toFixed(1) });
    }

    async function loadYear() {
      const gen = ++loadGen;
      let got, gotRec;
      try { got = await data(`captions/${year}.json`); }
      catch (e) { got = []; }
      try { gotRec = ((await data(`recaps/${year}.json`)) || {}).events || []; }
      catch (e) { gotRec = []; }
      if (stale() || gen !== loadGen) return; // navigated away or picked another year
      rows = got;
      recapsYr = gotRec;
      // a spotlight deep link lands in whatever class that corps marched
      if (spotWant) {
        const r0 = rows.find(r => r[iCorps()] === spotWant);
        if (r0) cls = r0[iCls()];
      }
      const cl = classesIn(rows);
      cls = cl.includes(cls) ? cls : (cl[0] || "");
      update();
    }

    // ---- caption titles: who took each caption at the championships ----
    // [key, column code, picker label]
    const TITLE_CAPS = [["ge", "GE", "General Effect"], ["vis", "VIS", "Visual Total"], ["vp", "VP", "Visual Proficiency"], ["va", "VA", "Visual Analysis"],
      ["cg", "CG", "Color Guard"], ["mus", "MUS", "Music Total"], ["br", "BR", "Brass"], ["ma", "MA", "Music Analysis"], ["pc", "PC", "Percussion"]];
    const titleSel = new Set(["ge", "br", "pc", "cg"]);
    let titlesMode = "years";
    let titlesData = null;
    multiSelect(document.getElementById("titlesCaps"), {
      label: "Pick captions…", bulk: true,
      options: TITLE_CAPS.map(([k, , full]) => ({ value: k, label: full })),
      selected: titleSel, onChange: renderTitles,
    });
    document.getElementById("titlesMode").onclick = () => {
      titlesMode = titlesMode === "years" ? "career" : "years";
      document.getElementById("titlesMode").textContent = titlesMode === "years" ? "Career totals" : "By year";
      renderTitles();
    };
    async function renderTitles() {
      if (!titlesData) titlesData = await data("caption_titles.json").catch(() => ({}));
      const el = document.getElementById("titlesBody");
      if (stale() || !el) return;
      const list = (titlesData[cls] || []).slice().sort((a, b) => b.y - a.y);
      const capsShown = TITLE_CAPS.filter(([k]) => titleSel.has(k));
      document.getElementById("titlesTitle").innerHTML =
        `Caption Titles <span class="sub">${esc(cls)} · best caption score at the championships, every year</span>`;
      if (!list.length || !capsShown.length) {
        el.innerHTML = `<div class='empty'>${capsShown.length ? "No championship recaps for this class yet." : "Pick at least one caption."}</div>`;
        return;
      }
      if (titlesMode === "years") {
        el.innerHTML = `<div class="tscroll"><table class="t"><thead><tr><th>Year</th>${capsShown.map(([, l]) => `<th>${l}</th>`).join("")}</tr></thead><tbody id="titleRows">
          ${list.map(e => `<tr><td style="white-space:nowrap"><a href="#/season/${e.y}"><b>${e.y}</b></a>${e.round !== "finals" ? ` <span class="kicker">${esc(e.round)}</span>` : ""}${e.partial ? ` <span class="kicker" title="recap missing: ${esc(e.partial.join(", "))}">partial</span>` : ""}</td>
            ${capsShown.map(([k]) => { const w = e.w[k]; return w ? `<td style="white-space:nowrap"><b>${esc(w[0])}</b> <span class="kicker">${(+w[1]).toFixed(2)}${w[2] ? "*" : ""}</span></td>` : "<td style='color:var(--muted)'>—</td>"; }).join("")}</tr>`).join("")}
        </tbody></table></div>`;
      } else {
        const count = new Map();
        list.forEach(e => capsShown.forEach(([k]) => {
          const w = e.w[k];
          if (!w) return;
          w[0].split(" & ").forEach(name => {
            const c = count.get(name) || { total: 0, per: {} };
            c.total++;
            c.per[k] = (c.per[k] || 0) + 1;
            count.set(name, c);
          });
        }));
        const rowsC = [...count.entries()].sort((a, b) => b[1].total - a[1].total);
        el.innerHTML = `<div class="tscroll"><table class="t"><thead><tr><th>${TERM_TH}</th>${capsShown.map(([, l]) => `<th class="num">${l}</th>`).join("")}<th class="num">Total</th></tr></thead><tbody id="titleRows">
          ${rowsC.map(([n, c]) => `<tr><td>${corpsLink(n)}</td>${capsShown.map(([k]) => `<td class="num">${c.per[k] || "—"}</td>`).join("")}<td class="num score">${c.total}</td></tr>`).join("")}
        </tbody></table></div>`;
      }
      collapseRows(document.getElementById("titleRows"), 5, titlesMode === "years" ? "seasons" : TERM.plural);
    }

    const _loadYear = loadYear;
    loadYear = async () => { await _loadYear(); renderTitles(); }; // year switch can reset the class
    singleSelect(document.getElementById("capYear"), {
      label: "Season", options: seasons.map(y => ({ value: String(y), label: String(y) })),
      value: String(year),
      onChange: v => { year = +v; seedPick = true; loadYear(); },
    });
    singleSelect(document.getElementById("capKey"), {
      label: "Caption", options: CAPTION_DEFS.map(([k, l]) => ({ value: k, label: l })),
      value: capKey,
      onChange: v => { capKey = v; seedPick = true; update(); },
    });
    await loadYear();
  }

  /* ============ DATABASE ============ */
  const DB = { scores: null, captions: null, sort: [0, -1] };
  async function loadScores() {
    if (DB.scores) return DB.scores;
    const idx = await data("db/index.json");
    const parts = await Promise.all(idx.map(d => data(`db/perfs_${d.decade}.json`)));
    DB.scores = parts.flat();
    return DB.scores;
  }
  async function loadCaptionRows() {
    if (DB.captions) return DB.captions;
    const idx = await data("captions/index.json");
    const parts = await Promise.all(idx.seasons.map(s =>
      data(`captions/${s.year}.json`).then(rows => rows.map(r => [s.year, ...r]))));
    DB.captions = parts.flat();
    return DB.captions;
  }

  // dataset configs: column labels, key row indices, loader
  const DB_SETS = {
    scores: {
      label: "Scores",
      cols: ["Year", "Date", "Event", TERM_TH, "Class", "Place", "Score"],
      corpsIdx: 3, clsIdx: 4, evIdx: 2, dateIdx: 1, scoreCols: [6],
      load: loadScores,
    },
    captions: {
      label: "Caption Scores",
      cols: ["Year", "Date", "Event", "Class", "Corps",
             "GE1", "GE2", "GE", "VP", "VA", "CG", "VIS",
             "BR", "MA", "PC", "MUS", "Pen", "Total"],
      corpsIdx: 4, clsIdx: 3, evIdx: 2, dateIdx: 1, scoreCols: [17],
      load: loadCaptionRows,
    },
  };

  async function viewDatabase(_m, stale) {
    setNav("data");
    app.innerHTML = `${dataSubNav("database")}<h1 class="page">Database <span id="dbcount" class="kicker"></span></h1>
      ${noteHtml("database")}
      <div class="filters" id="dbFilters">
        <div id="dbSet"></div>
        <div id="dbCorps"></div>
        <div id="dbYears"></div>
        <div id="fcls"></div>
        <input class="ctrl" id="fq" placeholder="Search event or ${TERM.singular}…">
        <button class="tab" id="dbReset" title="Clear all filters">Reset</button>
        <button class="tab" id="csv">Export CSV</button>
      </div>
      <div class="card"><div id="dbtable"><div class="loading">Loading…</div></div></div>`;

    let setKey = "scores";
    let cfg = DB_SETS[setKey];
    const CHUNK0 = 10;
    let shown = CHUNK0;
    let rows = [];
    let filtered = [];
    const corpsSet = new Set();
    const yearSet = new Set();
    let msDbCorps = null, msDbYears = null;
    let dbGen = 0;

    let fclsVal = "";
    let ssFcls = null;
    const ssSet = singleSelect(document.getElementById("dbSet"), {
      label: "Dataset",
      options: Object.entries(DB_SETS).filter(([k]) => CAPS || k !== "captions")
        .map(([k, v]) => ({ value: k, label: v.label })),
      value: setKey,
      onChange: v => { setKey = v; initDataset(); },
    });

    async function initDataset() {
      const gen = ++dbGen;
      document.getElementById("dbtable").innerHTML = "<div class='loading'>Loading…</div>";
      cfg = DB_SETS[setKey];
      let got;
      try { got = await cfg.load(); }
      catch (e) {
        const el = document.getElementById("dbtable");
        if (!stale() && el && gen === dbGen) el.innerHTML = "<div class='empty'>This dataset builds with the next data run.</div>";
        return;
      }
      if (stale() || gen !== dbGen || !document.getElementById("dbtable")) return;
      rows = got;
      DB.sort = [cfg.dateIdx, -1];   // freshest shows first
      corpsSet.clear(); yearSet.clear();
      document.getElementById("fq").value = "";

      const years = [...new Set(rows.map(r => r[0]))].sort((a, b) => b - a);
      const classes = sortClasses([...new Set(rows.map(r => r[cfg.clsIdx]).filter(Boolean))]);
      const corpsNames = [...new Set(rows.map(r => r[cfg.corpsIdx]).filter(Boolean))].sort();
      const clsOpts = [{ value: "", label: "All classes" }, ...classes.map(c => ({ value: c, label: c }))];
      fclsVal = "";
      if (!ssFcls) {
        ssFcls = singleSelect(document.getElementById("fcls"), {
          label: "All classes", options: clsOpts, value: "",
          onChange: v => { fclsVal = v || ""; apply(); },
        });
      } else {
        ssFcls.setOptions(clsOpts);
        ssFcls.set("");
      }

      const corpsOpts = corpsNames.map(n => ({ value: n, label: n }));
      const yearOpts = years.map(y => ({ value: String(y), label: String(y) }));
      if (!msDbCorps) {
        msDbCorps = multiSelect(document.getElementById("dbCorps"), {
          label: "All " + TERM.plural, searchable: true, bulk: true, bulkAll: false,
          options: corpsOpts, selected: corpsSet, onChange: apply,
        });
        msDbYears = multiSelect(document.getElementById("dbYears"), {
          label: "All seasons", searchable: years.length > 15, bulk: true,
          presets: [{ label: "Past 5", values: () => years.slice(0, 5) }],
          options: yearOpts, selected: yearSet, onChange: apply,
        });
      } else {
        msDbCorps.setOptions(corpsOpts);
        msDbYears.setOptions(yearOpts);
        msDbCorps.refresh(); msDbYears.refresh();
      }
      apply();
    }

    function apply() {
      shown = CHUNK0;
      const q = document.getElementById("fq").value.trim().toLowerCase();
      const cls = fclsVal;
      filtered = rows.filter(r =>
        (!yearSet.size || yearSet.has(String(r[0]))) &&
        (!corpsSet.size || corpsSet.has(r[cfg.corpsIdx])) &&
        (!cls || r[cfg.clsIdx] === cls) &&
        (!q || (r[cfg.evIdx] || "").toLowerCase().includes(q)
          || (r[cfg.corpsIdx] || "").toLowerCase().includes(q)));
      const [ci, dir] = DB.sort;
      filtered = filtered.slice().sort((a, b) => {
        const av = a[ci], bv = b[ci];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return (typeof av === "number" ? av - bv : String(av).localeCompare(String(bv))) * dir;
      });
      render();
    }

    function cellHtml(r, i) {
      if (i === 0) return `<td class="num m-hide" style="text-align:left">${r[0]}</td>`;
      if (i === cfg.dateIdx) return `<td style="color:var(--muted);white-space:nowrap">${fmtDate2(r[i], FAM ? r[0] : null)}</td>`;
      if (i === cfg.corpsIdx) return `<td>${corpsLink(r[i])}</td>`;
      if (i === cfg.clsIdx) return `<td class="m-hide"><span class="pill">${esc(r[i] || "")}</span></td>`;
      if (i === cfg.evIdx) return `<td>${esc(r[i] || "")}</td>`;
      const v = r[i];
      if (typeof v === "number") {
        const strong = cfg.scoreCols.includes(i) ? " score" : "";
        return `<td class="num${strong}">${cfg.scoreCols.includes(i) ? score3(v) : v.toFixed(v % 1 ? 2 : 0)}</td>`;
      }
      return `<td class="num">${v ?? "—"}</td>`;
    }

    function render() {
      document.getElementById("dbcount").textContent =
        `· ${filtered.length.toLocaleString()} rows`;
      const [ci, dir] = DB.sort;
      const more = filtered.length - shown;
      document.getElementById("dbtable").innerHTML =
        `<div class="tscroll dense"><table class="t"><thead><tr>${cfg.cols.map((c, i) =>
          `<th style="cursor:pointer;user-select:none" class="${i === 0 || i === cfg.clsIdx ? "m-hide" : ""}" data-c="${i}">${c}${i === ci ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead><tbody>
        ${filtered.slice(0, shown).map(r =>
          `<tr>${cfg.cols.map((c, i) => cellHtml(r, i)).join("")}</tr>`).join("")}</tbody></table></div>` +
        (more > 0 ? `<div class="expandwrap"><button class="tab" id="dbMore">Show ${Math.min(100, more).toLocaleString()} more ▾ <span class="kicker">(${(shown).toLocaleString()} of ${filtered.length.toLocaleString()})</span></button></div>` : "");
      const mb = document.getElementById("dbMore");
      if (mb) mb.onclick = () => { shown += 100; render(); };
      document.querySelectorAll("#dbtable th").forEach(th => th.onclick = () => {
        const c = +th.dataset.c;
        DB.sort = DB.sort[0] === c
          ? [c, -DB.sort[1]]
          : [c, c === 0 || c === cfg.dateIdx || cfg.scoreCols.includes(c) ? -1 : 1];
        apply();
      });
    }

    document.getElementById("fq").addEventListener("input", apply);
    document.getElementById("dbReset").onclick = () => {
      corpsSet.clear(); yearSet.clear();
      fclsVal = "";
      if (ssFcls) ssFcls.set("");
      document.getElementById("fq").value = "";
      if (msDbCorps) { msDbCorps.refresh(); msDbYears.refresh(); }
      apply();
    };
    document.getElementById("csv").onclick = () => {
      const lines = [cfg.cols.join(",")].concat(filtered.map(r =>
        cfg.cols.map((c, i) => {
          const v = r[i];
          return v == null ? "" : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
        }).join(",")));
      const blob = new Blob([lines.join("\n")], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `cadence-${setKey}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    await initDataset();
  }

  /* ============ RECORDS ============ */
  async function viewRecords(_m, stale) {
    setNav("data");
    const [rec, idx] = await Promise.all([data("records.json"), data("corps_index.json")]);
    if (stale()) return;
    const classes = sortClasses(Object.keys(rec));
    if (!classes.length) {
      app.innerHTML = dataSubNav("records")
        + '<h1 class="page">Records <span class="kicker">· the all-time book</span></h1>'
        + "<div class='card'><div class='empty'>The record book builds with the next data run.</div></div>";
      return;
    }
    const savedCls = localStorage.getItem(NS("dt-reccls"));
    let cls = classes.includes(savedCls) ? savedCls : (classes.includes("World Class") ? "World Class" : classes[0]);
    let marginMode = "closest";

    app.innerHTML = `
      ${dataSubNav("records")}
      <h1 class="page">Records <span class="kicker">· the all-time book</span></h1>
      ${noteHtml("records")}
      <div class="filters">
        <div id="recCls"></div>
        <div id="recEra"></div>
        <div id="recCorps"></div>
      </div>
      <div id="recBody"></div>`;

    let era = "all";
    const corpsSet = new Set();
    let msCorps = null;
    let ssEra = null;
    const ssCls = singleSelect(document.getElementById("recCls"), {
      label: "Class", options: classes.map(c => ({ value: c, label: c })), value: cls,
      onChange: v => {
        cls = v;
        localStorage.setItem(NS("dt-reccls"), cls);
        rebuildFilters();
        render();
      },
    });

    function rebuildFilters() {
      const d = rec[cls];
      const ys = [...new Set([...d.top.map(r => r[0]), ...Object.keys(d.finals).map(Number)])].sort((a, b) => a - b);
      const eraOpts = [{ value: "all", label: "All-time" }];
      if (ys.some(y => y >= 2013) && ys.some(y => y < 2013)) eraOpts.push({ value: "modern", label: "Modern era (2013–now)" });
      const decades = [...new Set(ys.map(y => Math.floor(y / 10) * 10))].sort((a, b) => b - a);
      if (decades.length > 1) decades.forEach(dd => eraOpts.push({ value: String(dd), label: `${dd}s` }));
      if (!eraOpts.some(o => o.value === era)) era = "all";
      if (!ssEra) {
        ssEra = singleSelect(document.getElementById("recEra"), {
          label: "Era", options: eraOpts, value: era,
          onChange: v => { era = v; render(); },
        });
      } else {
        ssEra.setOptions(eraOpts);
        ssEra.set(era);
      }
      const names = [...new Set([
        ...d.top.map(r => r[2]),
        ...Object.values(d.finals).flat().map(r => r[0]),
      ])].sort();
      const opts = names.map(n => ({ value: n, label: n }));
      if (!msCorps) {
        msCorps = multiSelect(document.getElementById("recCorps"), {
          label: "All " + TERM.plural, searchable: true, bulk: true, bulkAll: false,
          options: opts, selected: corpsSet, onChange: render,
        });
      } else {
        [...corpsSet].forEach(n => { if (!names.includes(n)) corpsSet.delete(n); });
        msCorps.setOptions(opts);
        msCorps.refresh();
      }
    }

    const inEra = y => {
      if (era === "all") return true;
      if (era === "modern") return y >= 2013;
      return Math.floor(y / 10) * 10 === +era;
    };
    const inCorps = n => !corpsSet.size || corpsSet.has(n);
    const yearLink = y => `<a href="#/season/${y}">${y}</a>`;

    function card(title, sub, body) {
      return `<div class="card"><h2>${title}${sub ? ` <span class="sub">${sub}</span>` : ""}</h2>${body}</div>`;
    }
    const emptyNote = "<div class='empty'>Nothing in this slice — widen the era or " + TERM.singular + " filter.</div>";

    function render() {
      const d = rec[cls];

      // finals per year, rows kept sorted by score
      const champBy = {};
      const champsOf = {};   // year -> every corps sharing the winning score
      Object.entries(d.finals).forEach(([y, rows]) => {
        if (!inEra(+y)) return;
        const sorted = rows.slice().sort((a, b) => (b[1] || 0) - (a[1] || 0));
        champBy[+y] = sorted;
        champsOf[+y] = sorted.filter(r => r[1] === sorted[0][1]).map(r => r[0]);
      });
      const champYears = Object.keys(champBy).map(Number).sort((a, b) => a - b);

      // 1 — highest single-show scores
      const top = d.top.filter(r => inEra(r[0]) && inCorps(r[2])).slice(0, 100);
      const topHtml = top.length ? `<div class="tscroll"><table class="t"><thead><tr><th>#</th><th>${TERM_TH}</th><th class="num">Score</th><th class="m-hide">Event</th><th>Date</th></tr></thead><tbody id="recTop">
        ${top.map((r, i) => `<tr><td class="rank">${i + 1}</td><td>${corpsLink(r[2])}</td><td class="num score">${score3(r[3])}</td><td class="m-hide" style="color:var(--muted);font-size:12.5px">${esc(r[4] || "")}</td><td style="white-space:nowrap">${fmtDate2(r[1], r[0])}</td></tr>`).join("")}
      </tbody></table></div>` : emptyNote;

      // 2 — championship titles
      const titleBy = new Map();
      champYears.forEach(y => {
        champsOf[y].forEach(c => {
          if (!inCorps(c)) return;
          const t = titleBy.get(c) || { n: 0, years: [] };
          t.n++;
          t.years.push(y);
          titleBy.set(c, t);
        });
      });
      const titles = [...titleBy.entries()].sort((a, b) => b[1].n - a[1].n || b[1].years[b[1].years.length - 1] - a[1].years[a[1].years.length - 1]);
      const titlesHtml = titles.length ? `<div class="tscroll"><table class="t"><thead><tr><th>${TERM_TH}</th><th class="num">Titles</th><th>Years</th></tr></thead><tbody id="recTitles">
        ${titles.map(([n, t]) => `<tr><td>${corpsLink(n)}</td><td class="num score">${t.n}</td><td class="kicker" style="max-width:260px">${t.years.join(" · ")}</td></tr>`).join("")}
      </tbody></table></div>` : emptyNote;

      // 3 — dynasties: consecutive titles over contested seasons
      const streaks = [];
      const running = new Map();   // corps -> current run
      champYears.forEach((y, yi) => {
        const prevChamps = yi > 0 ? champsOf[champYears[yi - 1]] : [];
        champsOf[y].forEach(c => {
          const run = running.get(c);
          if (run && prevChamps.includes(c)) { run.end = y; run.len++; }
          else running.set(c, { corps: c, start: y, end: y, len: 1 });
        });
        // close out runs that didn't continue this year
        [...running.entries()].forEach(([c, run]) => {
          if (!champsOf[y].includes(c) && run.end !== y) {
            if (run.len >= 2 && inCorps(c)) streaks.push(run);
            running.delete(c);
          }
        });
      });
      running.forEach((run, c) => { if (run.len >= 2 && inCorps(c)) streaks.push(run); });
      streaks.sort((a, b) => b.len - a.len || b.end - a.end);
      const streaksHtml = streaks.length ? `<div class="tscroll"><table class="t"><thead><tr><th>${TERM_TH}</th><th class="num">In a row</th><th>Span</th></tr></thead><tbody id="recStreaks">
        ${streaks.map(t => `<tr><td>${corpsLink(t.corps)}</td><td class="num score">${t.len}</td><td class="kicker">${t.start}–${t.end}</td></tr>`).join("")}
      </tbody></table></div>` : "<div class='empty'>No back-to-back champions in this slice.</div>";

      // 4 — finals margins
      const margins = [];
      champYears.forEach(y => {
        const rows = champBy[y];
        if (rows.length < 2 || rows[0][1] == null || rows[1][1] == null) return;
        if (corpsSet.size && !inCorps(rows[0][0]) && !inCorps(rows[1][0])) return;
        margins.push({ y, c1: rows[0][0], s1: rows[0][1], c2: rows[1][0], s2: rows[1][1], m: +(rows[0][1] - rows[1][1]).toFixed(3) });
      });
      margins.sort((a, b) => marginMode === "closest" ? a.m - b.m : b.m - a.m);
      const marginsHtml = margins.length ? `<div class="tscroll"><table class="t"><thead><tr><th>Year</th><th>Champion</th><th class="num">Score</th><th>Runner-up</th><th class="num m-hide">Score</th><th class="num">Margin</th></tr></thead><tbody id="recMargins">
        ${margins.map(g => `<tr><td>${yearLink(g.y)}</td><td><b>${esc(g.c1)}</b></td><td class="num score">${score3(g.s1)}</td><td>${esc(g.c2)}</td><td class="num m-hide">${score3(g.s2)}</td><td class="num" style="font-weight:650">${g.m.toFixed(3)}</td></tr>`).join("")}
      </tbody></table></div>` : emptyNote;

      // 5 — biggest one-season leaps (best score, year over year)
      const leaps = [];
      for (const c of idx) {
        if (!inCorps(c.name)) continue;
        const series = (c.series || []).slice().sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < series.length; i++) {
          const [y1, b1, k1] = series[i - 1], [y2, b2, k2] = series[i];
          if (y2 !== y1 + 1 || k2 !== cls || k1 !== cls || b1 == null || b2 == null || !inEra(y2)) continue;
          const dlt = +(b2 - b1).toFixed(3);
          if (dlt > 0) leaps.push({ corps: c.name, y1, y2, b1, b2, d: dlt });
        }
      }
      leaps.sort((a, b) => b.d - a.d);
      const leapsHtml = leaps.length ? `<div class="tscroll"><table class="t"><thead><tr><th>${TERM_TH}</th><th>Seasons</th><th class="num m-hide">From</th><th class="num m-hide">To</th><th class="num">Jump</th></tr></thead><tbody id="recLeaps">
        ${leaps.slice(0, 50).map(l => `<tr><td>${corpsLink(l.corps)}</td><td class="kicker">${l.y1} → ${l.y2}</td><td class="num m-hide">${score3(l.b1)}</td><td class="num m-hide">${score3(l.b2)}</td><td class="num score">+${l.d.toFixed(3)}</td></tr>`).join("")}
      </tbody></table></div>` : emptyNote;

      // 6 — most championship-finals appearances
      const appBy = new Map();
      champYears.forEach(y => {
        champBy[y].forEach(([c]) => {
          if (!inCorps(c)) return;
          const a = appBy.get(c) || { n: 0, first: y, last: y };
          a.n++;
          a.first = Math.min(a.first, y);
          a.last = Math.max(a.last, y);
          appBy.set(c, a);
        });
      });
      const apps = [...appBy.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last);
      const appsHtml = apps.length ? `<div class="tscroll"><table class="t"><thead><tr><th>${TERM_TH}</th><th class="num">Finals</th><th>First – Last</th></tr></thead><tbody id="recApps">
        ${apps.map(([n, a]) => `<tr><td>${corpsLink(n)}</td><td class="num score">${a.n}</td><td class="kicker">${a.first}–${a.last}</td></tr>`).join("")}
      </tbody></table></div>` : emptyNote;

      const finalsSpan = champYears.length ? `${champYears[0]}–${champYears[champYears.length - 1]}` : "";

      // longest span from a first title to a latest one, and the longest wait
      // between two consecutive titles — both counted straight off the years
      // in `titleBy`, which the era and corps filters have already narrowed
      const spans = [...titleBy.entries()].map(([n, t]) => ({ corps: n, n: t.n,
        first: t.years[0], last: t.years[t.years.length - 1],
        span: t.years[t.years.length - 1] - t.years[0] }))
        .filter(s => s.n > 1).sort((a, b) => b.span - a.span || b.n - a.n);
      const spansHtml = spans.length ? `<div class="tscroll"><table class="t"><thead><tr>
          <th>${TERM_TH}</th><th class="num">Span</th><th class="num m-hide">Titles</th><th>First – Last</th></tr></thead><tbody id="recSpans">
        ${spans.map(s => `<tr><td>${corpsLink(s.corps)}</td><td class="num score">${s.span} yr${s.span === 1 ? "" : "s"}</td>
          <td class="num m-hide">${s.n}</td><td class="kicker">${s.first}–${s.last}</td></tr>`).join("")}
      </tbody></table></div>` : emptyNote;
      const gaps = [];
      titleBy.forEach((t, n) => {
        for (let i = 1; i < t.years.length; i++)
          gaps.push({ corps: n, from: t.years[i - 1], to: t.years[i], gap: t.years[i] - t.years[i - 1] });
      });
      gaps.sort((a, b) => b.gap - a.gap || b.to - a.to);
      const gapsHtml = gaps.length ? `<div class="tscroll"><table class="t"><thead><tr>
          <th>${TERM_TH}</th><th class="num">Wait</th><th>Between</th></tr></thead><tbody id="recGaps">
        ${gaps.map(g => `<tr><td>${corpsLink(g.corps)}</td><td class="num score">${g.gap} yr${g.gap === 1 ? "" : "s"}</td>
          <td class="kicker">${g.from} → ${g.to}</td></tr>`).join("")}
      </tbody></table></div>` : emptyNote;
      document.getElementById("recBody").innerHTML = `
        ${card(FAM ? "Highest Winning Scores" : "Highest Scores Ever",
          FAM ? "the best championship-winning scores on record" : "the best single performances on record", topHtml)}
        <div class="grid cols-2" style="margin-top:14px">
          ${card("Championship Titles", finalsSpan, titlesHtml)}
          ${card("Dynasties", "back-to-back champions", streaksHtml)}
        </div>
        ${FAM ? `<div class="grid cols-2" style="margin-top:14px">
          ${card("Longest Title Span", "first title to latest", spansHtml)}
          ${card("Longest Wait Between Titles", "consecutive titles, years apart", gapsHtml)}
        </div>
        <div style="margin-top:14px">${card("Biggest One-Season Leaps", "winning score vs the year before", leapsHtml)}</div>`
        : `<div class="card" style="margin-top:14px">
          <h2>Finals Margins <span class="sub">champion vs runner-up on the last night</span></h2>
          <div class="filters" style="margin:2px 0 8px">
            <button class="tab${marginMode === "closest" ? " on" : ""}" data-mm="closest">Closest ever</button>
            <button class="tab${marginMode === "biggest" ? " on" : ""}" data-mm="biggest">Biggest blowouts</button>
          </div>
          ${marginsHtml}
        </div>
        <div class="grid cols-2" style="margin-top:14px">
          ${card("Biggest One-Season Leaps", "season best vs the year before", leapsHtml)}
          ${card("Most Finals Made", "championship-finals appearances", appsHtml)}
        </div>`}`;

      ["recTop", "recTitles", "recStreaks", "recMargins", "recLeaps", "recApps",
        "recSpans", "recGaps"].forEach(id => {
        const el = document.getElementById(id);
        if (el) collapseRows(el, 5, "rows");
      });
      document.querySelectorAll("[data-mm]").forEach(bt => bt.onclick = () => {
        marginMode = bt.dataset.mm;
        render();
      });
    }

    rebuildFilters();
    render();
  }

  /* ============ SUGGESTIONS ============ */
  const SUGGEST_REPO = "CadencePerformingArts/Cadence-Labs";
  async function viewSettings(_m, stale) {
    setNav("");
    const themeMode = (window.CadTheme && window.CadTheme.mode()) || (localStorage.getItem("cad-theme") || "auto");
    const curCorps = currentCorpsTheme();

    // corps to offer: everyone in the current season, every curated theme, and
    // whatever's currently applied — a relevant, searchable pool
    let all = [];
    try {
      const rk = await data("rankings.json");
      if (stale()) return;
      const st = rk.standings || {};
      (FAM ? CLASS_ORDER : ["World Class", "Open Class", "All-Age"])
        .forEach(c => (st[c] && st[c].rows || []).forEach(r => r.corps && all.push(r.corps)));
    } catch (e) {}
    if (!FAM) Object.keys(CORPS_THEME).forEach(n => all.push(n));
    // a family app has no CORPS_THEME to seed from, so its own roster is
    // the list — the whole index, not just this season's champions
    if (FAM) { try { (await data("corps_index.json") || []).forEach(r => r.name && all.push(r.name)); } catch (e) {} }
    if (curCorps) all.push(curCorps);
    all = [...new Set(all)].sort((a, b) => a.localeCompare(b));
    await ensureLogos(); // so the picker can show each corps' real logo
    if (stale()) return;
    const featured = FAM ? [] : THEME_FEATURED.filter(n => all.includes(n) || CORPS_THEME[n]);
    const fontSize = (() => { try { return localStorage.getItem("cad-fontsize") || "1"; } catch (e) { return "1"; } })();
    const custInit = currentCustom() || ["#0a3f6b", "#f0b429"]; // Cadence navy + gold to start

    const segBtn = (val, label) => `<button class="segbtn${themeMode === val ? " on" : ""}" data-theme-set="${val}">${label}</button>`;
    const fsBtn = (val, label) => `<button class="segbtn${fontSize === val ? " on" : ""}" data-fs-set="${val}">${label}</button>`;
    const twoTone = n => { const v = corpsThemeVars(n); return `--c1:${v.bar};--c2:${v.accent}`; };
    const chip = n => `<button class="corpschip${curCorps === n ? " on" : ""}" data-corps-set="${esc(n)}">${corpsLogo(n, 18)}${esc(n)}</button>`;
    // logo (or color-swatch fallback) on the left; when a real logo shows, the
    // color swatch still appears on the right as the theme preview
    const corpsRow = n => `<button class="corpsrow${curCorps === n ? " on" : ""}" data-corps-set="${esc(n)}" data-name="${esc(n.toLowerCase())}">`
      + corpsLogo(n, 24) + `<span class="corpsrow-name">${esc(n)}</span>`
      + (corpsHasLogo(n) ? `<span class="corpsrow-sw" style="${twoTone(n)}"></span>` : "") + `</button>`;
    const scope = (window.CadPush && CadPush.scope()) || "all";
    const selClasses = (window.CadPush && CadPush.classes) ? CadPush.classes() : null; // null = all
    const CLASS_OPTS = ["World Class", "Open Class", "All-Age"];
    const clsOn = c => !selClasses || selClasses.includes(c);

    app.innerHTML = h`
      <h1 class="page">Settings</h1>

      ${(window.CadInstall && !window.CadInstall.standalone()) ? `
      <div class="card setcard" id="installCard">
        <h2>${icoSvg(ICO_PHONE, 16)} Add to Home Screen</h2>
        <p class="setnote">Install Cadence like a real app — full screen, works offline, and it's how you get score alerts on iPhone.</p>
        <button class="tab" id="installOpen" type="button" style="font-weight:800;padding:11px 20px;font-size:14.5px">Show me how →</button>
      </div>` : ""}

      <div class="card setcard">
        <h2>Favorites</h2>
        <p class="setnote" id="favSummary">${FAVS.list().length
          ? `Following ${FAVS.list().map(n => `<b>${esc(n)}</b>`).join(", ")} — starred everywhere${FAM ? "" : ", first in score alerts"}.`
          : (FAM ? "Star " + TERM.plural + " to pin them to the top of every board and table." : "Star corps to pin them on the Scoreboard and lead your score alerts.")}</p>
        <button class="tab" id="favPick" type="button">Choose favorites</button>
      </div>

      <div class="dsk2">
        <div class="card setcard">
          <h2>Appearance</h2>
          <p class="setnote">Pick a light or dark look — or follow your device.</p>
          <div class="seg" id="themeSeg">${segBtn("auto", "Auto")}${segBtn("light", "Light")}${segBtn("dark", "Dark")}</div>
        </div>
        <div class="card setcard">
          <h2>Text Size</h2>
          <p class="setnote">Make everything a little easier to read.</p>
          <div class="seg" id="fsSeg">${fsBtn("1", "Default")}${fsBtn("1.1", "Large")}${fsBtn("1.2", "Larger")}</div>
        </div>
      </div>

      <div class="card setcard">
        <h2>Team Colors</h2>
        <p class="setnote">Paint Cadence in ${FAM ? "your own colors" : "your corps' colors"} — or keep the classic Cadence look.</p>
        <button class="setreset${curCorps ? " armed" : " on"}" data-corps-set="">
          <span class="corpschip-sw" style="background:#f0b429"></span>
          <span class="setreset-label">Cadence</span>
          <span class="setreset-hint">${curCorps ? "Reset to default" : "Default look"}</span>
          <svg class="setreset-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/></svg>
        </button>
        <div class="chipwrap">
          ${featured.map(chip).join("")}
        </div>
        <div class="corpsearch">
          <input type="search" id="corpsSearch" class="ctrl" placeholder="Search all corps…" autocomplete="off" autocapitalize="off" spellcheck="false">
          <div class="corpslist" id="corpsList">${all.map(corpsRow).join("")}</div>
          <div class="corpslist-empty" id="corpsEmpty" hidden>No corps match “<span id="corpsEmptyQ"></span>”.</div>
        </div>
        <div class="custombuild">
          <div class="custombuild-h">Or build your own <span class="kicker">just for fun</span></div>
          <div class="customrow">
            <label class="custompick"><input type="color" id="custBar" value="${custInit[0]}"><span>Primary</span></label>
            <label class="custompick"><input type="color" id="custAcc" value="${custInit[1]}"><span>Accent</span></label>
            <span class="corpsrow-sw custpreview" id="custPreview" style="--c1:${custInit[0]};--c2:${custInit[1]}"></span>
            <button class="tab pr-lock" id="custApply" type="button">Use these</button>
          </div>
        </div>
      </div>

      <div class="card setcard">
        <h2>Notifications</h2>
        <p class="setnote">Get a ping the moment new scores drop.</p>
        <div class="setrow">
          <div><b>Score alerts</b><div class="setsub" id="pushStatus">Checking…</div></div>
          <button class="toggle" id="pushToggle" aria-pressed="false" aria-label="Score alerts"></button>
        </div>
        <div class="setrow">
          <div><b>Only my favorites</b><div class="setsub">Alert just for your ★ corps</div></div>
          <button class="toggle${scope === "favs" ? " on" : ""}" id="scopeToggle" aria-pressed="${scope === "favs"}" aria-label="Favorites only"></button>
        </div>
        <div class="setrow setrow-classes">
          <div><b>Which classes</b><div class="setsub">Only alert me for the classes I follow</div></div>
        </div>
        <div class="classchips" id="classChips">
          ${CLASS_OPTS.map(c => `<button class="classchip${clsOn(c) ? " on" : ""}" data-cls="${esc(c)}" aria-pressed="${clsOn(c)}">${esc(c)}</button>`).join("")}
        </div>
      </div>

      <p class="setfoot">Preferences are saved on this device. Created by Lucas Besel.</p>`;
    if (stale()) return;

    // family pages: drop the cards whose feature only exists on the DCI app.
    // Score alerts need a live scores feed and the push relay's per-corps
    // registration (neither exists for a family circuit), and the install
    // prompt is wired by install.js, which family shells don't load — so
    // both cards would sit there doing nothing.
    if (FAM) app.querySelectorAll(".setcard").forEach(c => {
      const t = ((c.querySelector("h2") || {}).textContent) || "";
      if (/Add to Home Screen|Notifications|Prediction/i.test(t)) c.remove();
    });


    // appearance
    app.querySelectorAll("[data-theme-set]").forEach(b => b.addEventListener("click", () => {
      if (window.CadTheme) window.CadTheme.set(b.dataset.themeSet);
      app.querySelectorAll("[data-theme-set]").forEach(x => x.classList.toggle("on", x === b));
    }));

    // text size — scale the whole app (like browser zoom, layout-safe)
    app.querySelectorAll("[data-fs-set]").forEach(b => b.addEventListener("click", () => {
      applyFontSize(b.dataset.fsSet);
      app.querySelectorAll("[data-fs-set]").forEach(x => x.classList.toggle("on", x === b));
    }));

    // team colors — live preview, no full re-render (keeps scroll position)
    function pickCorps(name) {
      applyCorpsTheme(name);
      app.querySelectorAll("[data-corps-set]").forEach(x => x.classList.toggle("on", (x.dataset.corpsSet || "") === (name || "")));
      const reset = app.querySelector(".setreset");
      if (reset) {
        reset.classList.toggle("armed", !!name);
        const hint = reset.querySelector(".setreset-hint");
        if (hint) hint.textContent = name ? "Reset to default" : "Default look";
      }
    }
    // attach to each control (all live in this render's fresh innerHTML, so
    // they're replaced — not leaked — on the next visit)
    app.querySelectorAll("[data-corps-set]").forEach(btn =>
      btn.addEventListener("click", () => pickCorps(btn.dataset.corpsSet || "")));
    // search the corps list
    const search = document.getElementById("corpsSearch");
    const list = document.getElementById("corpsList");
    const empty = document.getElementById("corpsEmpty");
    if (search && list) search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      list.querySelectorAll(".corpsrow").forEach(row => {
        const hit = !q || (row.dataset.name || "").includes(q);
        row.hidden = !hit;
        if (hit) shown++;
      });
      if (empty) {
        empty.hidden = shown > 0;
        const qs = document.getElementById("corpsEmptyQ");
        if (qs) qs.textContent = search.value.trim();
      }
    });
    // custom primary + accent — just for fun
    const custBar = document.getElementById("custBar");
    const custAcc = document.getElementById("custAcc");
    const custPrev = document.getElementById("custPreview");
    const custApply = document.getElementById("custApply");
    const paintCustPreview = () => {
      if (custPrev && custBar && custAcc) { custPrev.style.setProperty("--c1", custBar.value); custPrev.style.setProperty("--c2", custAcc.value); }
    };
    if (custBar) custBar.addEventListener("input", paintCustPreview);
    if (custAcc) custAcc.addEventListener("input", paintCustPreview);
    if (custApply) custApply.addEventListener("click", () => {
      applyCustomTheme(custBar.value, custAcc.value);
      app.querySelectorAll("[data-corps-set]").forEach(x => x.classList.remove("on"));
      const reset = app.querySelector(".setreset");
      if (reset) {
        reset.classList.add("armed"); reset.classList.remove("on");
        const hint = reset.querySelector(".setreset-hint");
        if (hint) hint.textContent = "Reset to default";
      }
    });

    // add to home screen
    const installOpen = document.getElementById("installOpen");
    if (installOpen) installOpen.addEventListener("click", () => { if (window.CadInstall) window.CadInstall.open(); });

    // favorites picker — same sheet as first-run onboarding; re-render the
    // page on close so the summary (and alert personalization notes) refresh
    const favPick = document.getElementById("favPick");
    if (favPick) favPick.addEventListener("click", () => CadOnboard.open(true, () => {
      if ((location.hash || "") === "#/settings") route();
    }));

    // notifications
    const pushToggle = document.getElementById("pushToggle");
    const pushStatus = document.getElementById("pushStatus");
    // is the alert relay answering? Any HTTP response (even 404 from an older
    // build without /healthz) proves the server is up — only a network-level
    // failure counts as down. Never blocks the page; 2.5 s cap.
    async function relayUp() {
      const base = (window.CadConfig || {}).RELAY_URL;
      if (!base) return false;
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2500);
        const r = await fetch(base + "/healthz", { signal: ctl.signal });
        clearTimeout(t);
        return r.status > 0;
      } catch (e) { return false; }
    }
    async function paintPush() {
      if (!pushStatus || !pushToggle) return;
      if (!window.CadPush) { pushStatus.textContent = "Not available"; pushToggle.disabled = true; return; }
      const s = await CadPush.status();
      if (s === "unsupported") { pushStatus.textContent = "Not supported in this browser"; pushToggle.disabled = true; pushToggle.classList.remove("on"); return; }
      if (s === "ios-install") { pushStatus.textContent = "On iPhone, install the app first (Share → Add to Home Screen), then reopen Cadence"; pushToggle.disabled = true; pushToggle.classList.remove("on"); return; }
      if (s !== "on" && "Notification" in window && Notification.permission === "denied") {
        pushStatus.textContent = "Blocked — allow notifications for this site in your browser settings, then reopen Cadence";
        pushToggle.disabled = true; pushToggle.classList.remove("on");
        return;
      }
      pushToggle.disabled = false;
      pushToggle.classList.toggle("on", s === "on");
      pushToggle.setAttribute("aria-pressed", s === "on");
      pushStatus.textContent = s === "on" ? "On — you'll get a ping when scores drop" : "Off";
      // relay trouble is worth a heads-up only when alerts are meant to be on
      if (s === "on") relayUp().then(up => {
        if (!up && pushStatus.isConnected && pushToggle.classList.contains("on"))
          pushStatus.textContent = "On — but the alert server isn't responding right now, so alerts may be delayed";
      });
    }
    if (pushToggle) pushToggle.addEventListener("click", async () => {
      if (!window.CadPush || pushToggle.disabled) return;
      const s = await CadPush.status();
      pushToggle.disabled = true;
      pushStatus.textContent = "…";
      if (s === "on") await CadPush.disable();
      else { const r = await CadPush.enable(); if (r && !r.ok && r.reason) alert(r.reason); }
      await paintPush();
    });
    const scopeToggle = document.getElementById("scopeToggle");
    if (scopeToggle) scopeToggle.addEventListener("click", () => {
      const next = scopeToggle.classList.toggle("on") ? "favs" : "all";
      scopeToggle.setAttribute("aria-pressed", next === "favs");
      if (window.CadPush) CadPush.setScope(next);
    });
    /* The "Prediction results" toggle used to sit here. It wrote
       its own localStorage key on click and read it back only to paint its
       own state — nothing decided whether to send a reminder from it. A
       control that claims to silence a notification and does nothing is worse
       than no control, so it is gone rather than stubbed. */
    const clsChips = [...app.querySelectorAll("#classChips .classchip")];
    clsChips.forEach(ch => ch.addEventListener("click", () => {
      ch.classList.toggle("on");
      ch.setAttribute("aria-pressed", ch.classList.contains("on"));
      const picked = clsChips.filter(c => c.classList.contains("on")).map(c => c.dataset.cls);
      if (window.CadPush && CadPush.setClasses) CadPush.setClasses(picked);
    }));
    paintPush();
  }

  // Ask Cadence — natural-language questions answered from the official scores.
  // The thread persists across navigation within a session so follow-ups work.
  let askThread = []; // [{ role: "user"|"assistant", content }]
  async function viewAsk(_m, stale) {
    setNav("");
    // real feature flag, not just a hidden button: the assistant renders an
    // honest unavailable state until BOTH this flag and the relay's own
    // server-side gate are switched on
    if (!(window.CadConfig || {}).ASK_ENABLED) {
      app.innerHTML = `
        <h1 class="page">Ask Cadence <span class="kicker">· scores assistant</span></h1>
        <div class="card"><div class="empty">The scores assistant is switched off right now.<br>
          Everything else works without it — try the <a href="#/">Scoreboard</a> or <a href="#/stats">Stats</a>.</div></div>`;
      return;
    }
    let year = new Date().getUTCFullYear();
    try {
      const meta = await data("meta.json");
      if (stale()) return;
      year = Math.max(...meta.seasons.map(s => s.year));
    } catch (e) {}
    const SUGGEST = [
      "Who's winning World Class this season?",
      "Did Boston Crusaders pass the Bluecoats this year, and when?",
      "Show me Carolina Crown's scores this season",
      "Who won the most recent show?",
    ];
    const sendIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>`;
    app.innerHTML = h`
      <h1 class="page">Ask Cadence <span class="kicker">· scores assistant</span></h1>
      <p class="lede">Ask anything about the ${year} DCI season in plain English — head-to-heads, a corps' run of scores, who won a show. Every answer comes straight from the official scores.</p>
      <div class="card askcard">
        <div id="askLog" class="asklog" aria-live="polite"></div>
        <div id="askChips" class="askchips"></div>
        <form id="askForm" class="askform" autocomplete="off">
          <input id="askInput" class="askinput" type="text" maxlength="500" placeholder="e.g. Did Pacific Crest pass Madison Scouts, and when?" aria-label="Ask a question about DCI scores" />
          <button class="asksend" type="submit" aria-label="Ask">${sendIcon}</button>
        </form>
        <p class="asknote">Grounded in the published scores — but the assistant can still make mistakes, so double-check anything important against the scoreboard.</p>
      </div>`;
    const log = document.getElementById("askLog");
    const chips = document.getElementById("askChips");
    const form = document.getElementById("askForm");
    const input = document.getElementById("askInput");
    const send = form.querySelector(".asksend");

    function bubble(role, html, cls) {
      const div = document.createElement("div");
      div.className = "askmsg " + role + (cls ? " " + cls : "");
      div.innerHTML = html;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      return div;
    }
    const asText = t => esc(t).replace(/\n/g, "<br>");
    // repaint any prior thread from this session
    askThread.forEach(m => bubble(m.role === "user" ? "user" : "bot", asText(m.content)));
    if (!askThread.length)
      chips.innerHTML = SUGGEST.map(s => `<button class="askchip" type="button">${esc(s)}</button>`).join("");

    let busy = false;
    async function submit(q) {
      q = (q || "").trim();
      if (!q || busy) return;
      busy = true; send.disabled = true;
      chips.innerHTML = "";
      input.value = "";
      bubble("user", asText(q));
      askThread.push({ role: "user", content: q });
      const typing = bubble("bot", '<span class="askdots"><i></i><i></i><i></i></span>');
      try {
        const r = await CadAsk.ask(q, { year, history: askThread.slice(0, -1).slice(-6) });
        typing.remove();
        bubble("bot", asText(r.answer));
        askThread.push({ role: "assistant", content: r.answer });
      } catch (e) {
        typing.remove();
        bubble("bot", asText(e.message || "Something went wrong — try again in a moment."), "err");
      } finally {
        busy = false; send.disabled = false; input.focus();
      }
    }
    form.addEventListener("submit", e => { e.preventDefault(); submit(input.value); });
    chips.addEventListener("click", e => {
      const b = e.target.closest(".askchip");
      if (b) submit(b.textContent);
    });
    input.focus();
  }

  // notification deep-link resolver: #/go?y=&d=&e= -> the show's event page.
  // Turns a show's name+date (all the relay knows) into its event index,
  // falling back to that year's Shows list if the data hasn't caught up yet.
  async function viewGo(qs) {
    const p = new URLSearchParams(qs || "");
    const y = p.get("y"), d = p.get("d"), e = p.get("e"), c = p.get("c");
    if (!y) { location.replace("#/"); return; }
    try {
      const events = await data(`seasons/${y}.json`);
      let idx = -1;
      if (e) idx = events.findIndex(ev => ev.date === d && ev.name === e);
      if (idx < 0 && d) idx = events.findIndex(ev => ev.date === d);
      // carry the alert's corps through so the event page lands on their row
      if (idx >= 0) { location.replace(`#/event/${y}/${idx}${c ? `?c=${encodeURIComponent(c)}` : ""}`); return; }
    } catch (err) {}
    location.replace(`#/events?y=${y}`);
  }

  // About, data sources, non-affiliation, and privacy — the app's honest
  // self-description. Everything stated here must stay true to the actual
  // implementation (no accounts, no trackers, relay stores only what /subscribe
  // is sent). Update this page whenever that reality changes.
  function viewAbout() {
    setNav("");
    // the About page is DCI's; family apps hand off to the canonical copy
    if (FAM) { location.href = (FAM.root || ".") + "/#/about"; return; }
    const cfg = window.CadConfig || {};
    const relayHost = (() => { try { return new URL(cfg.RELAY_URL).host; } catch (e) { return null; } })();
    app.innerHTML = `
      <h1 class="page">About Cadence</h1>
      <div class="card cardgap">
        <h2>What This Is</h2>
        <p class="abouttxt">Cadence is a free scores dashboard for Drum Corps International (DCI)
          competition: live season standings, judge-level caption recaps, corps histories, and
          complete published results back to 1972. It covers DCI's World Class, Open Class, and
          All-Age divisions. Cadence also publishes the WGI Color Guard, Percussion and Winds
          championship record — every World Champion and winning score — since WGI releases
          in-season scores only through its directors-only portal.</p>
        <p class="abouttxt"><b>Cadence is an independent fan project.</b> It is not affiliated with,
          sponsored by, or endorsed by Drum Corps International, CompetitionSuite, or any corps.
          All corps names and event names belong to their respective organizations.</p>
      </div>
      <div class="card cardgap">
        <h2>Where the Scores Come From</h2>
        <p class="abouttxt">Scores are collected from publicly published sources and credited:
          <a href="https://www.dci.org/scores" target="_blank" rel="noopener">DCI.org</a> (primary, with caption recaps),
          <a href="https://www.drum-corps.net" target="_blank" rel="noopener">drum-corps.net</a>,
          <a href="https://downbeatdesigns.com" target="_blank" rel="noopener">Downbeat Designs</a>,
          CompetitionSuite's public score feeds, and
          <a href="https://www.soundmachine.org/dci/dcihistory.htm" target="_blank" rel="noopener">The Sound Machine</a> historical archive.
          Collection is rate-limited and cached to keep load on those sites minimal, and every
          caption sheet is re-verified arithmetically before it's published here. Scores can be
          corrected at the source; Cadence picks up corrections on its next update cycle.</p>
      </div>
      <div class="card cardgap">
        <h2>Privacy</h2>
        <p class="abouttxt">Cadence has no accounts and no sign-in. Your favorites, theme, team
          colors, text size, predictions, and seen-item markers are stored only in this browser
          — they never leave your device.</p>
        <p class="abouttxt">There is no advertising and no behavioral analytics. The app makes no
          requests to tracking services.</p>
        <p class="abouttxt"><b>Score alerts</b> are the one optional feature that stores anything
          off-device: turning them on registers an anonymous browser push endpoint${relayHost ? ` with the
          alert relay (<span class="mono">${esc(relayHost)}</span>)` : ""} along with your starred corps and
          class preferences, so notifications can be personalized. No name, email, or identifier
          is attached. Turning alerts off asks the relay to delete that registration, and you can
          also revoke notification permission in your browser or device settings at any time. The
          relay keeps only aggregate counters and recent error messages for troubleshooting; its
          hosting provider may keep standard server request logs.</p>
        <p class="abouttxt">External links (venue pages, news articles, GitHub) lead to third-party
          sites with their own policies. The "Ask Cadence" assistant is currently unavailable.</p>
      </div>
      <div class="card">
        <h2>Contact &amp; Source</h2>
        <p class="abouttxt">Questions, corrections, or ideas: open an issue on
          <a href="https://github.com/${SUGGEST_REPO}/issues" target="_blank" rel="noopener">GitHub</a>
          or use the <a href="#/suggestions">Suggestions</a> page. The full source code is public.</p>
        <p class="abouttxt" style="margin-bottom:0">Created by Lucas Besel${cfg.RELEASE ? ` · release <span class="mono">${esc(String(cfg.RELEASE))}</span>` : ""}</p>
      </div>`;
  }

  async function viewSuggestions(_m, stale) {
    setNav("");
    app.innerHTML = `
      <h1 class="page">Suggestions <span class="kicker">· help decide what gets built</span></h1>
      <div class="card cardgap">
        <h2>Have an Idea?</h2>
        <p style="margin:0 0 12px;color:var(--text-secondary)">Missing a stat? Want a new view? Post it below — suggestions are public, and the most-wanted ideas get built first. A free GitHub account is all it takes.</p>
        <a class="tab on" style="display:inline-block;text-decoration:none" href="https://github.com/${SUGGEST_REPO}/issues/new?template=suggestion.yml" target="_blank" rel="noopener">Post a suggestion →</a>
      </div>
      <div class="card"><h2>What People Are Asking For</h2><div id="sugList"><div class="loading">Loading…</div></div></div>
      <p style="color:var(--muted);font-size:12.5px;margin:14px 2px 0">Created by Lucas Besel · suggestions live on <a href="https://github.com/${SUGGEST_REPO}/issues" target="_blank" rel="noopener">GitHub</a></p>`;
    let items = [];
    try {
      const res = await fetch(`https://api.github.com/repos/${SUGGEST_REPO}/issues?labels=suggestion&state=open&sort=reactions-+1&per_page=50`);
      if (!res.ok) throw new Error(res.status);
      items = await res.json();
    } catch (e) {
      const el = document.getElementById("sugList");
      if (!stale() && el) el.innerHTML = `<div class="empty">Couldn't load suggestions right now.<br><a class="tab" style="display:inline-block;margin-top:12px" href="https://github.com/${SUGGEST_REPO}/issues" target="_blank" rel="noopener">View them on GitHub →</a></div>`;
      return;
    }
    const el = document.getElementById("sugList");
    if (stale() || !el) return;
    if (!items.length) {
      el.innerHTML = "<div class='empty'>No suggestions yet — be the first!</div>";
      return;
    }
    el.innerHTML = items.map(it => h`
      <div style="padding:12px 2px;border-bottom:1px solid var(--grid)">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
          <b>${esc(it.title)}</b>
          <span class="kicker" style="white-space:nowrap">👍 ${(it.reactions && it.reactions["+1"]) || 0}</span>
        </div>
        ${it.body ? h`<div style="color:var(--text-secondary);font-size:13.5px;margin-top:4px">${esc(String(it.body).slice(0, 220))}${String(it.body).length > 220 ? "…" : ""}</div>` : ""}
        <div class="kicker" style="margin-top:6px">${esc(it.user ? it.user.login : "")} · ${esc(fmtDateY(String(it.created_at || "").slice(0, 10)))} · <a href="${encodeURI(it.html_url)}" target="_blank" rel="noopener">discuss ↗</a></div>
      </div>`).join("");
  }

  /* ============ router ============ */
  const routes = [
    // "#/" is the current season; "#/?y=1994" is that season's board
    [/^#?\/?(?:\?(.*))?$/, (m, st) => viewRankings(m[1], st)],
    [/^#\/compare(?:\?(.*))?$/, (m, st) => viewCorpsHub(m[1], st)],
    [/^#\/corps\?(.*)$/, m => { location.replace(`#/compare?${m[1]}`); }],
    [/^#\/corps$/, (m, st) => viewCorpsPage(null, st)],
    [/^#\/corps\/([a-z0-9-]+)$/, (m, st) => viewCorpsPage(m[1], st)],
    [/^#\/events(?:\?(.*))?$/, (m, st) => viewEvents(m[1], st)],
    [/^#\/predictions$/, viewPredictions],
    [/^#\/(?:seasons|champions)$/, viewSeasons],
    // Stats hub entry — lands on the captions front page. "#/data" is the
    // legacy name for the same hub; keep both redirecting forever so old
    // shared links never break.
    [/^#\/(?:stats|data)$/, () => { location.replace(CAPS ? "#/captions" : "#/compare"); }],
    [/^#\/season\/(\d{4})$/, m => { location.replace(FAM ? `#/?y=${m[1]}` : `#/events?y=${m[1]}`); }],
    [/^#\/event\/(\d{4})\/(\d+)(?:\?(.*))?$/, (m, st) => viewEvent(m[1], m[2], st, m[3])],
    [/^#\/captions(?:\?(.*))?$/, (m, st) => { if (!CAPS) { location.replace("#/compare"); return; } return viewCaptions(m[1], st); }],
    [/^#\/records$/, viewRecords],
    [/^#\/settings$/, viewSettings],
    [/^#\/go(?:\?(.*))?$/, m => viewGo(m[1])],
    [/^#\/ask$/, viewAsk],
    [/^#\/about$/, viewAbout],
    [/^#\/suggestions$/, viewSuggestions],
    [/^#\/database$/, viewDatabase],
    // legacy routes from earlier versions
    [/^#\/(today|rankings)$/, (m, st) => viewRankings("", st)],
    [/^#\/season\/dci\/(\d{4})$/, m => { location.replace(`#/events?y=${m[1]}`); }],
  ];

  let firstBuildPending = false;
  let navGen = 0; // bumped per navigation; stale async view work bails out
  /* ===== per-tab memory =====
     Each top-level tab remembers where you last were (an open event, a
     corps, a stats sub-page with its filters-in-URL) and takes you back
     there. Tapping the tab you're already on returns to its front page. */
  const NAV_DEFAULT = { rankings: "#/", events: "#/events", corps: "#/corps", data: CAPS ? "#/captions" : "#/compare" };
  function sectionOf(hash) {
    if (/^#\/(events|event\/|season\/|predictions)/.test(hash)) return "events";
    if (/^#\/corps/.test(hash)) return "corps";
    if (/^#\/(stats|data|compare|captions|champions|seasons|records|database)/.test(hash)) return "data";
    if (/^#?\/?(\?.*)?$/.test(hash)) return "rankings";   // incl. "#/?y=1994"
    return null; // suggestions etc. carry no tab memory
  }
  function rememberSpot() {
    const hash = location.hash || "#/";
    const sec = sectionOf(hash);
    if (sec) { try { sessionStorage.setItem(NS("cad-last-" + sec), hash); } catch (e) {} }
    const fab = document.getElementById("askFab");
    if (fab) fab.hidden = /^#\/ask$/.test(hash); // hide the shortcut on its own page
    document.querySelectorAll("#nav a").forEach(a => {
      const r = a.dataset.route;
      // Cadence puts a Workspace link in this nav, and it is a plain href to
      // ensemble/ rather than a hash route. Without this guard r is undefined,
      // NAV_DEFAULT[undefined] is undefined, and the anchor's href is set to
      // the literal string "undefined" on first paint — every Workspace tab
      // led to a 404.
      if (!r || !NAV_DEFAULT[r]) return;
      a.setAttribute("href", r === sec ? NAV_DEFAULT[r]
        : (sessionStorage.getItem(NS("cad-last-" + r)) || NAV_DEFAULT[r]));
    });
  }
  // views fine-tune their URL with replaceState (filters, picked corps…) —
  // capture those spots too
  const _replaceState = history.replaceState.bind(history);
  history.replaceState = (s, t, url) => { _replaceState(s, t, url); rememberSpot(); };

  async function route() {
    const gen = ++navGen;
    const stale = () => gen !== navGen;
    const hashv = location.hash || "#/";
    rememberSpot();
    window.scrollTo(0, 0);
    for (const [re, fn] of routes) {
      const m = hashv.match(re);
      if (m) {
        try { await fn(m, stale); } catch (e) {
          if (stale()) return; // a view we already left failed — ignore
          console.error(e);
          app.innerHTML = firstBuildPending
            ? `<div class="card" style="text-align:center;padding:48px 20px">
                 <div style="line-height:0;color:var(--muted);margin-bottom:12px" aria-hidden="true"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 10v4M9.5 7v10M14.5 9.5v5M19 5v14"/></svg></div>
                 <h2 style="margin:0 0 8px">First Data Build in Progress</h2>
                 <p style="color:var(--text-secondary);max-width:52ch;margin:0 auto">Scores are being pulled from DCI.org right now. This page fills in automatically when it finishes.</p>
               </div>`
            : `<div class="card"><div class="empty">Couldn't load this view (${CCViz.esc(e.message)}). Data may be mid-update — try again in a minute.</div></div>`;
        }
        return;
      }
    }
    app.innerHTML = "<div class='empty'>Page not found.</div>";
  }
  // info bubbles: hover (mouse) or tap (touch) any [data-tip] element
  (() => {
    const tip = document.getElementById("tooltip");
    let cur = null;
    function show(el) {
      cur = el;
      tip.innerHTML = el.dataset.tip;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = r.left + r.width / 2 - tw / 2 + scrollX;
      x = Math.max(8, Math.min(x, scrollX + innerWidth - tw - 8));
      let y = r.top + scrollY - th - 10;
      if (y < scrollY + 4) y = r.bottom + scrollY + 10;
      tip.style.left = x + "px";
      tip.style.top = y + "px";
    }
    const hide = () => { if (cur) { tip.hidden = true; cur = null; } };
    document.addEventListener("pointerover", e => {
      if (e.pointerType !== "mouse") return;
      const el = e.target.closest("[data-tip]");
      if (el) show(el);
      else if (cur) hide();
    });
    document.addEventListener("click", e => {
      const el = e.target.closest("[data-tip]");
      if (el && e.target.closest("a")) return;      // links still navigate
      if (el) { (cur === el && !tip.hidden) ? hide() : show(el); }
      else hide();
    });
    addEventListener("scroll", hide, { passive: true });
  })();

  // live scores: on show nights the pipeline lands new data every half hour —
  // poll the stamp while the tab is open and offer a one-tap refresh
  // the top-bar stamp reads as "how fresh", not a raw timestamp — it
  // re-renders every half minute and rolls forward whenever data applies
  function paintUpdated(metaStamp) {
    const el = document.getElementById("updated");
    if (!el) return;
    if (metaStamp) el.dataset.stamp = metaStamp;
    const s = el.dataset.stamp;
    if (!s) return;
    const t = Date.parse(s.replace(" UTC", "Z").replace(" ", "T"));
    if (isNaN(t)) { el.textContent = "Updated " + s; return; }
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    // plain minutes — under normal operation this never exceeds ~30
    const ago = mins < 1 ? "<1 min ago"
      : mins < 180 ? `${mins} min ago`
      : mins < 36 * 60 ? `${Math.round(mins / 60)} h ago`
      : `${Math.round(mins / 1440)} d ago`;
    // the pipeline rebuilds every ~15 min year-round, so a stamp hours old
    // means updates have stalled — flag it quietly rather than pretending
    // the board is current. Cached offline data trips this too, which is
    // exactly right: it isn't live.
    const stale = mins > 120;
    el.classList.toggle("stale", stale);
    el.textContent = `Updated ${ago}`;
    el.title = stale
      ? `Data from ${s} — updates seem delayed right now; scores may lag until the pipeline catches up`
      : `Data from ${s} — refreshes several times an hour — every 3 min on show nights`;
  }
  setInterval(() => paintUpdated(), 30 * 1000);

  (() => {
    // On show days we read scores from raw.githubusercontent.com, which reflects
    // a new-scores commit the moment the pipeline pushes it — GitHub purges
    // raw's CDN cache on every push, and it sends `access-control-allow-origin:
    // *` so the browser can fetch it directly. That's ~1–2 minutes ahead of the
    // GitHub Pages CDN (which has to finish a build+deploy), so the scoreboard
    // updates as fast as the source itself has the scores. Off-season / on
    // failure it falls back to the normal Pages data.
    const RAW = "https://raw.githubusercontent.com/CadencePerformingArts/Cadence-Labs/main/docs/data/";
    let stamp = null;
    let toast = null;
    let showActive = false;
    // Signature of the actual scores we last saw. The build timestamp bumps on
    // every rebuild (re-scrapes, unrelated data commits), so it can't tell "new
    // scores" from "just refreshed". This does: it's the set of every corps'
    // latest score/date/event across all classes — the same fields the relay
    // uses to decide a show is genuinely new.
    let scoresSig = null;
    function signatureOf(rk) {
      if (!rk || !rk.standings) return "";
      const parts = [];
      for (const cls of Object.keys(rk.standings).sort()) {
        const rows = (rk.standings[cls].rows || []).slice()
          .sort((a, b) => (a.corps < b.corps ? -1 : a.corps > b.corps ? 1 : 0));
        for (const r of rows) parts.push(cls + "|" + r.corps + "|" + r.score + "|" + r.date + "|" + r.event);
      }
      return parts.join(";");
    }
    // seed the rankings cache so the scoreboard paints the fresh scores the
    // instant we swap, even before Pages has them
    const seedRankings = rk => { if (rk && rk.standings) cache.set("rankings.json", Promise.resolve(rk)); };
    function flashNote(html) {
      const flash = document.createElement("div");
      flash.id = "liveToast";
      flash.style.pointerEvents = "none";
      flash.innerHTML = html;
      document.body.appendChild(flash);
      setTimeout(() => flash.remove(), 2500);
    }
    // new scores while the user is mid-read: offer a tap instead of yanking
    function offer(newStamp, seed) {
      if (toast) return;
      toast = document.createElement("button");
      toast.id = "liveToast";
      toast.innerHTML = "🥁 New scores just landed — <b>tap to refresh</b>";
      toast.onclick = () => {
        cache.clear();
        seedRankings(seed);
        toast.remove();
        toast = null;
        stamp = newStamp;
        paintUpdated(newStamp);
        route();
      };
      document.body.appendChild(toast);
    }
    // new scores and it's safe to swap right now (on focus): repaint + announce
    function applyNow(newStamp, seed) {
      cache.clear();
      seedRankings(seed);
      stamp = newStamp;
      paintUpdated(newStamp);
      if (toast) { toast.remove(); toast = null; }
      route();
      flashNote("✓ <b>Scores updated</b>");
    }
    // the data rebuilt but no scores actually changed: keep everything fresh and
    // give the little "refreshed" nod — WITHOUT claiming new scores or yanking
    // the page with a re-render.
    function refreshedQuietly(newStamp, seed) {
      cache.clear();
      seedRankings(seed);
      stamp = newStamp;
      paintUpdated(newStamp);
      flashNote("✓ <b>Refreshed</b>");
    }
    // freshest stamp available right now: raw on show days (with Pages
    // fallback), Pages otherwise. `?t=` busts any browser/proxy cache.
    async function freshMeta() {
      if (showActive) {
        try {
          const r = await fetch(RAW + "meta.json?t=" + Date.now(), { cache: "no-store" });
          if (r.ok) { const m = await r.json(); if (m && m.updated) return { updated: m.updated, raw: true }; }
        } catch (e) { /* raw hiccup — fall through to Pages */ }
      }
      const r = await fetch("data/meta.json?t=" + Date.now(), { cache: "no-cache" });
      if (!r.ok) return null;
      const m = await r.json();
      return m && m.updated ? { updated: m.updated, raw: false } : null;
    }
    async function check(auto) {
      if (document.hidden) return;
      try {
        const m = await freshMeta();
        if (!m) return;
        if (!stamp) { stamp = m.updated; return; }   // first sight: just baseline
        if (m.updated === stamp) return;              // nothing rebuilt since last look

        // the build stamp moved — pull the fresh scores (raw on show days so the
        // board can lead the Pages deploy) and check whether the SCORES actually
        // changed. A rebuild on its own (re-scrape, unrelated commit) isn't news.
        let seed = null;
        if (m.raw) { try { seed = await (await fetch(RAW + "rankings.json?t=" + Date.now(), { cache: "no-store" })).json(); } catch (e) {} }
        if (!seed) { try { seed = await (await fetch("data/rankings.json?t=" + Date.now(), { cache: "no-cache" })).json(); } catch (e) {} }
        const newSig = signatureOf(seed);
        const changed = !!newSig && scoresSig != null && newSig !== scoresSig;
        if (newSig) scoresSig = newSig;

        if (changed) {
          if (auto) applyNow(m.updated, seed); // returning to the app: swap now
          else offer(m.updated, seed);         // mid-read: offer a tap
        } else {
          refreshedQuietly(m.updated, seed);   // refreshed, but no new scores
        }
      } catch (e) { /* offline — try again next tick */ }
    }
    // Poll fast on show days (a show today or last night, for late West-Coast
    // results) so an open app shows new scores within ~30s of them landing;
    // sip the rest of the year. visibilitychange refreshes instantly on focus.
    async function refreshShowFlag() {
      try {
        const up = await data("upcoming.json");
        // Eastern, not UTC. Deriving the day in UTC rolls the date over at
        // 8pm Eastern, so tonight's show dropped off the 30s fast-poll list
        // while it was still running — exactly when live scores matter most.
        const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
        const day = ms => etFmt.format(new Date(ms));
        const now = Date.now();
        const days = new Set([day(now), day(now - 864e5)]);
        showActive = (up || []).some(e => days.has(e.date));
      } catch (e) { /* keep prior flag */ }
    }
    // baseline the score signature from the first data we load, so the first
    // genuine change afterward reads as "new scores" (not a plain refresh)
    data("rankings.json").then(rk => { if (scoresSig == null) scoresSig = signatureOf(rk); }).catch(() => {});
    check(false); // one immediate check while we learn whether a show is on
    // start the adaptive loop only after the show-flag is known, so a show day
    // gets the 30s cadence (and the raw fast-path) from the very first tick
    refreshShowFlag().then(() => (function loop() {
      setTimeout(() => { check(false); loop(); }, showActive ? 30000 : 180000);
    })());
    setInterval(refreshShowFlag, 15 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) check(true); });
  })();

  window.CadRedraw = route; // theme toggle re-renders the current view
  addEventListener("hashchange", route);
  // logo tap: home with a clean slate — filters reset, preferences (theme,
  // favorites) kept
  const brandEl = document.querySelector(".brand");
  if (brandEl) brandEl.addEventListener("click", () => {
    ["dt-class", "dt-corpsclass"].forEach(k => localStorage.removeItem(NS(k)));
    ["cmp-corps", "cmp-years", "cad-shows-f",
      "cad-last-rankings", "cad-last-events", "cad-last-corps", "cad-last-data"]
      .forEach(k => sessionStorage.removeItem(NS(k)));
    if ((location.hash || "#/") === "#/") route(); // already home: force a fresh render
  });

  data("meta.json").then(m => {
    paintUpdated(m.updated);
    route();
    // first-run onboarding waits for the first view to paint, never blocks it
    setTimeout(() => CadOnboard.maybeShow(), 800);
  }).catch(() => {
    firstBuildPending = true;
    document.getElementById("updated").textContent = "awaiting first data build";
    route();
  });
})();
