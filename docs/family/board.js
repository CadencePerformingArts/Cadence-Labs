/* Cadence family — scoreboards for circuits where a season trend line can't
   work. The engine (family/app.js viewRankings) hands off here when
   APP_CFG.board is "event" (BOA: ~1.3 performances/band/season, but 49 years
   of history), "rating" (UIL: Division ratings, no point scores),
   "placement" (ISSMA: State Finals ordinals only) or "history" (WGI: no
   published score feed — champions record + official schedule).

   Contract: window.CadBoard.render({app, data, stale, shape, cfg, helpers})
   — see family/BOARD-CONTRACT.md. Reads data/insights.json when present and
   degrades to computing from rankings/corps_index/seasons when it isn't.
   Self-contained: no build step, charts via window.CCViz plus a few new
   chart types drawn in the same visual grammar. */
(function () {
  "use strict";

  /* board.css ships next to this file but the app shells don't link it —
     inject it once, resolved against this script's own URL. */
  (function injectCss() {
    if (typeof document === "undefined") return;
    if (document.querySelector("link[data-cad-board]")) return;
    const cs = document.currentScript;
    const href = cs && cs.src ? cs.src.replace(/board\.js[^/]*$/, "board.css") : "../family/board.css";
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-cad-board", "1");
    document.head.appendChild(link);
  })();

  /* ---------- tiny shared utilities ---------- */
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtD(iso) {
    if (!iso) return "";
    const p = String(iso).split("-").map(Number);
    return p.length >= 3 ? `${MONTHS[p[1] - 1]} ${p[2]}` : String(iso);
  }
  function fmtDY(iso) {
    if (!iso) return "";
    const p = String(iso).split("-").map(Number);
    return p.length >= 3 ? `${MONTHS[p[1] - 1]} ${p[2]}, ${p[0]}` : String(iso);
  }
  const ORD = n => {
    n = Math.round(n);
    const s = ["th", "st", "nd", "rd"], k = n % 100;
    return n + (s[(k - 20) % 10] || s[k] || s[0]);
  };
  function median(arr) {
    const a = arr.filter(v => v != null).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }
  const num1 = v => (v == null ? "—" : (+v).toFixed(1));
  /* CCViz.esc covers text nodes but leaves double quotes alone — run
     already-escaped strings through this before putting them in attributes */
  const qa = s => String(s == null ? "" : s).replace(/"/g, "&quot;");

  /* stable per-ensemble colors — same spread palette the engine hashes into,
     so a band keeps one color across every chart on the page */
  const PAL = [
    "#e8590c", "#1971c2", "#2f9e44", "#6741d9", "#c2255c", "#0c8599",
    "#a61e4d", "#495057", "#b35c00", "#66a80f", "#f03e3e", "#9c36b5",
    "#3b5bdb", "#d6336c", "#087f5b", "#846358",
  ];
  function colorOf(name) {
    const n = String(name || "");
    let h = 0;
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    return PAL[h % PAL.length];
  }

  function deltaPill(d, digits) {
    if (d == null) return '<span class="delta flat">—</span>';
    if (Math.abs(d) < 1e-9) return '<span class="delta flat">±0</span>';
    const t = digits == null ? Math.abs(d).toFixed(1) : Math.abs(d).toFixed(digits);
    return `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${t}</span>`;
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  /* ---------- SVG chart plumbing (house style: hairline grid, 11px labels,
     2px lines, halo-ringed markers, one shared tooltip) ---------- */
  const SVG_NS = "http://www.w3.org/2000/svg";
  function themeVar(name, fb) {
    try {
      return (getComputedStyle(document.documentElement).getPropertyValue(name) || "").trim() || fb;
    } catch (e) { return fb; }
  }
  const CH = () => ({
    grid: themeVar("--ch-grid", "#e4e9f1"),
    base: themeVar("--ch-base", "#c4cdda"),
    label: themeVar("--ch-label", "#74808f"),
    ink: themeVar("--ch-ink", "#2c3a55"),
    halo: themeVar("--ch-halo", "#ffffff"),
  });
  function svgEl(name, attrs, parent) {
    const n = document.createElementNS(SVG_NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function fitWidth(container) {
    const w = container.getBoundingClientRect().width || 860;
    return Math.max(360, Math.min(860, Math.round(w)));
  }

  const RATING_LABELS = { 1: "Superior", 2: "Excellent", 3: "Good", 4: "Fair", 5: "Poor" };
  const ROMAN = ["", "I", "II", "III", "IV", "V"];
  const ratingColor = r => themeVar(`--bd-r${r}`, ["", "#2f9e44", "#1971c2", "#f0b429", "#e8590c", "#c92a2a"][r]);

  /* Stacked share-of-ratings bars: one bar per year, segments are Division
     I..V shares (I at the bottom — the good news reads off the baseline). */
  function stackedShare(container, opts) {
    container.innerHTML = "";
    const years = opts.years;
    if (!years.length) { container.innerHTML = '<div class="empty">No ratings yet.</div>'; return; }
    const W = fitWidth(container), H = opts.height || 300;
    const m = { top: 14, right: 12, bottom: 26, left: 42 };
    const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, container);
    for (const tv of [0, 25, 50, 75, 100]) {
      const y = m.top + ih - (tv / 100) * ih;
      svgEl("line", { x1: m.left, x2: W - m.right, y1: y, y2: y, stroke: CH().grid, "stroke-width": 1 }, svg);
      const t = svgEl("text", { x: m.left - 8, y: y + 4, "text-anchor": "end", fill: CH().label, "font-size": 11 }, svg);
      t.textContent = tv + "%";
    }
    svgEl("line", { x1: m.left, x2: W - m.right, y1: m.top + ih, y2: m.top + ih, stroke: CH().base, "stroke-width": 1 }, svg);

    const n = years.length, step = iw / n, bw = Math.min(34, step * 0.72);
    const totals = [];
    years.forEach((yr, i) => {
      const c = opts.counts(yr) || {};
      let tot = 0;
      for (let r = 1; r <= 5; r++) tot += c[r] || c[String(r)] || 0;
      totals.push(tot);
      if (!tot) return;
      const x = m.left + i * step + (step - bw) / 2;
      let y0 = m.top + ih;
      for (let r = 1; r <= 5; r++) {
        const v = c[r] || c[String(r)] || 0;
        if (!v) continue;
        const hgt = (v / tot) * ih;
        svgEl("rect", { x: x.toFixed(1), y: (y0 - hgt).toFixed(1), width: bw.toFixed(1), height: Math.max(0.5, hgt).toFixed(1), fill: ratingColor(r) }, svg);
        y0 -= hgt;
      }
    });
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 46))));
    years.forEach((yr, i) => {
      if (i % every !== 0 && i !== n - 1) return;
      const t = svgEl("text", { x: m.left + i * step + step / 2, y: H - 8, "text-anchor": "middle", fill: CH().label, "font-size": 11 }, svg);
      t.textContent = String(yr);
    });

    const hover = svgEl("rect", { x: m.left, y: m.top, width: iw, height: ih, fill: "transparent" }, svg);
    const tipFor = i => {
      const yr = years[i], c = opts.counts(yr) || {}, tot = totals[i];
      if (!tot) return `<div class="tt-title">${yr}</div><div class="tt-row"><span class="tt-name">no published ratings</span></div>`;
      let rows = "";
      for (let r = 1; r <= 5; r++) {
        const v = c[r] || c[String(r)] || 0;
        if (!v) continue;
        rows += `<div class="tt-row"><span class="tt-key" style="background:${ratingColor(r)}"></span>` +
          `<span class="tt-val">${v}</span> <span class="tt-name">Division ${ROMAN[r]} — ${RATING_LABELS[r]} · ${Math.round(v / tot * 100)}%</span></div>`;
      }
      return `<div class="tt-title">${yr} · ${tot} ${CCViz.esc(opts.noun || "bands")}</div>${rows}`;
    };
    const move = evt => {
      const r = svg.getBoundingClientRect();
      const px = (evt.clientX - r.left) / r.width * W;
      const i = Math.max(0, Math.min(n - 1, Math.floor((px - m.left) / step)));
      CCViz.showTip(tipFor(i), evt.clientX, evt.clientY, evt.pointerType === "touch");
    };
    hover.addEventListener("pointermove", move);
    hover.addEventListener("pointerdown", move);
    hover.addEventListener("pointerleave", () => CCViz.hideTip());
    hover.addEventListener("pointercancel", () => CCViz.hideTip());
  }

  /* Placement-over-time: inverted y axis so 1st sits at the top, ordinal
     ticks, dots on every finals appearance. */
  function placementChart(container, opts) {
    container.innerHTML = "";
    const pts = (opts.points || []).filter(p => p.y != null).slice().sort((a, b) => a.x - b.x);
    if (!pts.length) { container.innerHTML = '<div class="empty">No placements on record.</div>'; return; }
    const W = fitWidth(container), H = opts.height || 280;
    const m = { top: 16, right: 30, bottom: 26, left: 46 };
    const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
    let xMin = pts[0].x, xMax = pts[pts.length - 1].x;
    if (xMin === xMax) { xMin -= 1; xMax += 1; }
    const yMax = Math.max(5, ...pts.map(p => p.y));
    const X = v => m.left + (v - xMin) / (xMax - xMin) * iw;
    const Y = v => m.top + ((v - 1) / Math.max(1, yMax - 1)) * ih; // 1st at the top
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, container);
    const stepT = Math.max(1, Math.ceil((yMax - 1) / 5));
    for (let tv = 1; tv <= yMax; tv += stepT) {
      svgEl("line", { x1: m.left, x2: W - m.right, y1: Y(tv), y2: Y(tv), stroke: CH().grid, "stroke-width": 1 }, svg);
      const t = svgEl("text", { x: m.left - 8, y: Y(tv) + 4, "text-anchor": "end", fill: CH().label, "font-size": 11 }, svg);
      t.textContent = ORD(tv);
    }
    svgEl("line", { x1: m.left, x2: W - m.right, y1: m.top + ih, y2: m.top + ih, stroke: CH().base, "stroke-width": 1 }, svg);
    const yrs = pts.map(p => p.x);
    const every = Math.max(1, Math.ceil(yrs.length / Math.max(1, Math.floor(iw / 60))));
    yrs.forEach((yr, i) => {
      if (i % every !== 0 && i !== yrs.length - 1) return;
      const t = svgEl("text", { x: X(yr), y: H - 8, "text-anchor": "middle", fill: CH().label, "font-size": 11 }, svg);
      t.textContent = String(yr);
    });
    const color = opts.color || PAL[1];
    const d = pts.map((p, j) => (j ? "L" : "M") + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1)).join(" ");
    svgEl("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    pts.forEach(p => {
      svgEl("circle", { cx: X(p.x), cy: Y(p.y), r: 3.5, fill: color, stroke: CH().halo, "stroke-width": 2 }, svg);
    });
    const last = pts[pts.length - 1];
    const lab = svgEl("text", { x: Math.min(X(last.x) + 8, W - 2), y: Y(last.y) + 4, fill: CH().ink, "font-size": 11, "font-weight": 650 }, svg);
    lab.textContent = ORD(last.y);

    const hover = svgEl("rect", { x: m.left, y: m.top, width: iw, height: ih, fill: "transparent" }, svg);
    const move = evt => {
      const r = svg.getBoundingClientRect();
      const vx = xMin + ((evt.clientX - r.left) / r.width * W - m.left) / iw * (xMax - xMin);
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.x - vx) < Math.abs(best.x - vx)) best = p;
      CCViz.showTip(
        `<div class="tt-title">${best.x}</div><div class="tt-row"><span class="tt-key" style="background:${color}"></span>` +
        `<span class="tt-val">${CCViz.esc(ORD(best.y))}</span> <span class="tt-name">${CCViz.esc(best.cls || "")}</span></div>`,
        evt.clientX, evt.clientY, evt.pointerType === "touch");
    };
    hover.addEventListener("pointermove", move);
    hover.addEventListener("pointerdown", move);
    hover.addEventListener("pointerleave", () => CCViz.hideTip());
    hover.addEventListener("pointercancel", () => CCViz.hideTip());
  }

  /* ---------- pure compute helpers (also exercised by the node harness) ---------- */

  /* corps_index.json series entries are [year, value, class] — value is best
     score (BOA), best (lowest) rating (UIL) or placement (ISSMA). */
  function seriesMap(entry) {
    const m = new Map();
    for (const e of (entry && entry.series) || []) m.set(e[0], e);
    return m;
  }

  /* biggest year-over-year movement in season bests, latest two seasons */
  function computeYoY(index, latestYear) {
    const out = [];
    for (const c of index || []) {
      const m = seriesMap(c);
      const a = m.get(latestYear - 1), b = m.get(latestYear);
      if (!a || !b || a[1] == null || b[1] == null) continue;
      out.push({
        corps: c.name, class: b[2] || "", from: a[1], to: b[1],
        delta: +(b[1] - a[1]).toFixed(3), years: [latestYear - 1, latestYear],
      });
    }
    return out.sort((x, y) => y.delta - x.delta);
  }

  /* {class: {year: {rating: bandCount}}} from each band's best rating of the year */
  function ratingDistFromIndex(index) {
    const out = {};
    for (const c of index || []) {
      for (const e of c.series || []) {
        const [yr, r, cls] = e;
        if (r == null || !cls) continue;
        ((out[cls] = out[cls] || {})[yr] = out[cls][yr] || {})[r] = (out[cls][yr][r] || 0) + 1;
      }
    }
    return out;
  }

  /* Superior-streak bookkeeping over a [year, rating, class] series.
     A streak is calendar-consecutive years rated Division I — a year with no
     published rating breaks it (we never guess at unrated years). */
  function streakStats(series) {
    const s = (series || []).filter(e => e[1] != null).slice().sort((a, b) => a[0] - b[0]);
    const st = { current: 0, currentSpan: null, longest: 0, longestSpan: null, superiors: 0, rated: s.length, latest: s[s.length - 1] || null, first: s.length ? s[0][0] : null };
    let run = 0, runStart = 0, prevYr = null;
    for (const [yr, r] of s) {
      if (r === 1) {
        st.superiors++;
        if (prevYr != null && yr === prevYr + 1 && run > 0) run++;
        else { run = 1; runStart = yr; }
        if (run > st.longest) { st.longest = run; st.longestSpan = [runStart, yr]; }
      } else run = 0;
      prevYr = yr;
    }
    // current streak counts back from the latest rated year
    if (st.latest && st.latest[1] === 1) {
      const byYear = new Map(s.map(e => [e[0], e[1]]));
      let yr = st.latest[0], n = 0;
      while (byYear.get(yr) === 1) { n++; yr--; }
      st.current = n;
      st.currentSpan = [st.latest[0] - n + 1, st.latest[0]];
    }
    return st;
  }

  /* UIL region contests: share of Division I per region, one season */
  function regionAgg(events) {
    const regions = new Map();
    for (const ev of events || []) {
      if (ev.stage && ev.stage !== "region") continue;
      const m = /\bReg(?:ion)?\.?\s*(\d+)/i.exec(ev.name || "");
      if (!m) continue;
      const key = +m[1];
      const agg = regions.get(key) || { region: key, n: 0, sup: 0 };
      for (const c of ev.classes || []) {
        for (const r of c.results || []) {
          const rating = r.rating != null ? r.rating : r.score;
          if (rating == null) continue;
          agg.n++;
          if (Math.round(rating) === 1) agg.sup++;
        }
      }
      regions.set(key, agg);
    }
    return [...regions.values()].filter(a => a.n > 0)
      .map(a => ({ ...a, share: a.sup / a.n }))
      .sort((x, y) => y.share - x.share || y.n - x.n);
  }

  /* ISSMA dynasty rows from corps_index series (placements) */
  function dynastyFromIndex(index, cls) {
    const rows = [];
    for (const c of index || []) {
      const s = (c.series || []).filter(e => e[1] != null && (!cls || e[2] === cls));
      if (!s.length) continue;
      const places = s.map(e => e[1]);
      rows.push({
        corps: c.name,
        titles: places.filter(p => p === 1).length,
        podiums: places.filter(p => p <= 3).length,
        apps: s.length,
        best: Math.min(...places),
        first: Math.min(...s.map(e => e[0])),
        last: Math.max(...s.map(e => e[0])),
        lastCls: s[s.length - 1][2] || "",
      });
    }
    return rows.sort((x, y) => y.titles - x.titles || y.podiums - x.podiums || y.apps - x.apps || x.best - y.best || x.corps.localeCompare(y.corps));
  }

  /* WGI honor roll: champions.json {year: {class: {corps, score}}} → per-class
     rows and per-ensemble title counts */
  function titleRows(champions, cls) {
    const rows = [];
    for (const yr of Object.keys(champions || {})) {
      const c = champions[yr] && champions[yr][cls];
      if (c && c.corps) rows.push({ year: +yr, corps: c.corps, score: c.score });
    }
    return rows.sort((a, b) => b.year - a.year);
  }
  function titleCounts(champions, cls) {
    const byCorps = new Map();
    for (const yr of Object.keys(champions || {})) {
      const classes = cls ? [cls] : Object.keys(champions[yr] || {});
      for (const k of classes) {
        const c = champions[yr] && champions[yr][k];
        if (!c || !c.corps) continue;
        const t = byCorps.get(c.corps) || { corps: c.corps, titles: 0, years: [] };
        t.titles++;
        t.years.push(+yr);
        byCorps.set(c.corps, t);
      }
    }
    const rows = [...byCorps.values()];
    for (const r of rows) {
      r.years.sort((a, b) => a - b);
      r.first = r.years[0];
      r.latest = r.years[r.years.length - 1];
    }
    return rows.sort((x, y) => y.titles - x.titles || y.latest - x.latest || x.corps.localeCompare(y.corps));
  }

  /* BOA caption profile: a band's season averages vs its class average.
     rows are the flat caption arrays (captions/{year}.json), cols the column
     names from captions/index.json. Prefers granular captions when scraped. */
  function captionProfile(rows, cols, band, cls) {
    const iCls = cols.indexOf("class"), iCorps = cols.indexOf("corps");
    if (iCls < 0 || iCorps < 0) return [];
    const GRAN = [["mi", "Music Individual"], ["me", "Music Ensemble"], ["vi", "Visual Individual"],
      ["ve", "Visual Ensemble"], ["ge1", "General Effect 1"], ["ge2", "General Effect 2"]];
    const FALL = [["mus", "Music"], ["vis", "Visual"], ["ge", "General Effect"]];
    const bandRows = rows.filter(r => r[iCorps] === band && r[iCls] === cls);
    const clsRows = rows.filter(r => r[iCls] === cls);
    if (!bandRows.length || !clsRows.length) return [];
    const avg = (set, ki) => {
      let s = 0, n = 0;
      for (const r of set) if (r[ki] != null) { s += r[ki]; n++; }
      return n ? s / n : null;
    };
    const build = defs => defs.map(([k, label]) => {
      const ki = cols.indexOf(k);
      if (ki < 0) return null;
      const b = avg(bandRows, ki), a = avg(clsRows, ki);
      if (b == null || a == null) return null;
      return { key: k, label, band: b, avg: a, diff: +(b - a).toFixed(2) };
    }).filter(Boolean);
    const g = build(GRAN);
    return g.length >= 3 ? g : build(FALL);
  }

  /* ---------- shared HTML builders (helpers bag H = engine helpers) ---------- */

  /* podium strip for one class at one event; kind "score" | "placement" */
  function podiumHTML(H, results, kind, fmtScore) {
    const top = results.slice(0, 3);
    if (!top.length) return "";
    const s1 = top[0] && top[0].score;
    return `<div class="bd-podium">${top.map((r, i) => {
      const place = r.place != null ? r.place : i + 1;
      const trim = v => Math.abs(v).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
      let sub = "";
      if (kind === "score" && r.score != null) {
        if (i === 0 && top[1] && top[1].score != null) sub = `won by ${trim(r.score - top[1].score)}`;
        else if (i > 0 && s1 != null) sub = `−${trim(s1 - r.score)} behind`;
      }
      return `<div class="bd-spot p${place <= 3 ? place : 3}">
        <span class="bd-med">${H.esc(ORD(place))}</span>
        <div class="bd-spot-band">${H.corpsLogo(r.corps, 30)}<span>${H.corpsLink(r.corps)}</span></div>
        ${kind === "score" ? `<div class="bd-score">${fmtScore(r.score)}</div>` : ""}
        ${sub ? `<div class="bd-gap">${H.esc(sub)}</div>` : ""}
      </div>`;
    }).join("")}</div>`;
  }

  /* full results table for a score event: place, band, score, context columns */
  function resultsTableHTML(H, results, fmtScore) {
    const med = median(results.map(r => r.score));
    const s1 = results.length ? results[0].score : null;
    const n = results.length;
    return `<div class="tscroll"><table class="t"><thead><tr>
      <th>#</th><th>Band</th><th class="num">Score</th><th class="num">vs median</th>
      <th class="num m-hide">Behind</th><th class="num m-hide">Finish</th></tr></thead><tbody>
      ${results.map((r, i) => {
        const place = r.place != null ? r.place : i + 1;
        const dm = r.score != null && med != null ? r.score - med : null;
        const behind = r.score != null && s1 != null && place > 1 ? s1 - r.score : null;
        return `<tr${H.FAVS && H.FAVS.has(r.corps) ? ' class="favrow"' : ""}>
          <td class="rank">${place}</td>
          <td><span class="corpscell">${H.corpsLogo(r.corps, 24)}<span class="corpscell-body"><span class="corpscell-name">${H.corpsLink(r.corps)}</span></span></span></td>
          <td class="num score">${fmtScore(r.score)}</td>
          <td class="num">${dm == null ? "—" : deltaPill(dm, 1)}</td>
          <td class="num m-hide">${behind == null ? "—" : behind.toFixed(3)}</td>
          <td class="num m-hide" style="color:var(--muted)">${H.esc(`${ORD(place)} of ${n}`)}</td>
        </tr>`;
      }).join("")}
    </tbody></table></div>
    ${med != null ? `<div class="bd-foot">Class median at this event: <b>${fmtScore(med)}</b> · one judging panel, so every number here is directly comparable.</div>` : ""}`;
  }

  /* UIL rating history strip: one cell per year, first→last */
  function heatstripHTML(H, series, first, last) {
    const byYear = new Map((series || []).map(e => [e[0], e]));
    let out = '<div class="bd-heat">';
    for (let yr = first; yr <= last; yr++) {
      const e = byYear.get(yr);
      if (!e || e[1] == null) {
        out += `<span class="bd-cell miss" title="${yr} — no published rating"><small>${yr}</small><b>·</b></span>`;
      } else {
        const r = Math.round(e[1]);
        out += `<span class="bd-cell r${r}" title="${qa(H.esc(`${yr} · Division ${ROMAN[r] || r} (${RATING_LABELS[r] || ""})${e[2] ? " · " + e[2] : ""}`))}"><small>${yr}</small><b>${ROMAN[r] || r}</b></span>`;
      }
    }
    return out + "</div>";
  }

  function yoyListHTML(H, list, fmtScore) {
    if (!list.length) return '<div class="empty">Needs two consecutive seasons of scores.</div>';
    return `<div class="bd-yoy">${list.map(m => `<div class="bd-yoyrow">
      <span class="who">${H.corpsLink(m.corps)} ${m.class ? `<span class="classbadge">${H.esc(String(m.class).replace(/^Class\s+/, ""))}</span>` : ""}</span>
      <span class="path">${fmtScore(m.from)} → ${fmtScore(m.to)}</span>
      ${deltaPill(m.delta, 1)}
    </div>`).join("")}</div>`;
  }

  /* ---------- small interactive bits ---------- */

  /* searchable typeahead over up to a few thousand names — msel look, no msel
     dependency (the engine doesn't export its pickers) */
  function typeahead(mount, cfg) {
    // cfg: {placeholder, options: [{name, hint}], value, favs, onPick}
    mount.classList.add("bd-pick");
    mount.innerHTML = `<input class="ctrl" type="text" autocomplete="off" spellcheck="false"
      placeholder="${cfg.placeholder || "Search…"}"><div class="bd-pick-panel" hidden></div>`;
    const inp = mount.querySelector("input"), panel = mount.querySelector(".bd-pick-panel");
    const esc = CCViz.esc;
    let current = cfg.value || "";
    inp.value = current;
    const rank = o => (cfg.favs && cfg.favs.has(o.name) ? -1 : 0);
    function matches(q) {
      const out = [];
      for (const o of cfg.options) {
        const i = o.name.toLowerCase().indexOf(q);
        if (i >= 0) out.push([rank(o), i, o]);
        if (out.length > 400) break;
      }
      out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].name.localeCompare(b[2].name));
      return out.slice(0, 24).map(e => e[2]);
    }
    function show(list) {
      if (!list.length) { panel.hidden = true; return; }
      panel.innerHTML = list.map(o =>
        `<button type="button" class="bd-pick-opt" data-name="${qa(esc(o.name))}">${esc(o.name)}${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ""}</button>`).join("");
      panel.hidden = false;
    }
    inp.addEventListener("input", () => {
      const q = inp.value.trim().toLowerCase();
      if (q.length < 1) { panel.hidden = true; return; }
      show(matches(q));
    });
    inp.addEventListener("focus", () => { inp.select(); });
    inp.addEventListener("blur", () => setTimeout(() => { panel.hidden = true; inp.value = current; }, 150));
    panel.addEventListener("pointerdown", e => {
      const btn = e.target.closest(".bd-pick-opt");
      if (!btn) return;
      e.preventDefault();
      current = btn.dataset.name;
      inp.value = current;
      panel.hidden = true;
      inp.blur();
      cfg.onPick(current);
    });
    return { set: v => { current = v || ""; inp.value = current; } };
  }

  /* collapse long tables behind a Show-all tab (same look as the engine's) */
  function collapseRows(tbody, n, noun, favs) {
    if (!tbody) return;
    const host = tbody.closest(".tscroll") || tbody.closest("table").parentElement;
    const old = host.nextElementSibling;
    if (old && old.classList && old.classList.contains("expandwrap")) old.remove();
    const rows = [...tbody.rows];
    if (rows.length <= n + 3) return;
    let open = false;
    const apply = () => rows.slice(n).forEach(r => r.classList.toggle("hid", !open && !r.classList.contains("favrow")));
    const wrap = document.createElement("div");
    wrap.className = "expandwrap";
    const btn = document.createElement("button");
    btn.className = "tab";
    btn.onclick = () => {
      open = !open;
      apply();
      btn.textContent = open ? `Show Top ${n} ▴` : `Show All ${rows.length} ${noun} ▾`;
      if (!open && host.getBoundingClientRect().top < 0) host.scrollIntoView({ block: "start" });
    };
    btn.textContent = `Show All ${rows.length} ${noun} ▾`;
    apply();
    wrap.appendChild(btn);
    host.after(wrap);
  }

  function tabsHTML(items, onKey) {
    return items.map(t => `<button class="tab bd-mini${t.on ? " on" : ""}" data-${onKey}="${qa(CCViz.esc(t.key))}">${CCViz.esc(t.label)}</button>`).join("");
  }
  function wireTabs(host, attr, fn) {
    host.querySelectorAll(`[data-${attr}]`).forEach(b => b.onclick = () => {
      host.querySelectorAll(`[data-${attr}]`).forEach(x => x.classList.toggle("on", x === b));
      fn(b.dataset[attr.replace(/-(.)/g, (_, c) => c.toUpperCase())]);
    });
  }

  const insightsFoot = ins => ins && ins.updated
    ? `<p class="pagenote">Insights updated ${CCViz.esc(String(ins.updated))}.</p>` : "";

  /* ================================================================
     SHAPE "event" — BOA. One or two shows a season kills a season trend
     line, so the board leads with event results (one panel = honest
     comparisons), then multi-season program trajectories (up to 49 real
     points), caption strengths vs the class, YoY movement, and an
     honestly-labeled season-best board. */
  async function renderEvent(ctx) {
    const { app, data, stale, cfg } = ctx;
    const H = ctx.helpers;
    const esc = H.esc;
    const [rk, index, insights, meta] = await Promise.all([
      data("rankings.json"),
      data("corps_index.json").catch(() => []),
      data("insights.json").catch(() => null),
      data("meta.json").catch(() => null),
    ]);
    if (stale()) return;
    await H.ensureLogos();
    if (stale()) return;

    const season = rk.season || (insights && insights.latest_year) || new Date().getFullYear();
    const idxMap = new Map((index || []).map(c => [c.name, c]));
    const fmtScore = H.score3;
    const years = ((meta && meta.seasons) || []).map(s => s.year).sort((a, b) => b - a);
    if (!years.length) years.push(season);

    app.innerHTML = `
      <h1 class="page">${esc(String(season))} Scoreboard</h1>
      ${cfg.scoreNote ? `<p class="kicker" style="margin:-6px 2px 12px">${esc(cfg.scoreNote)}</p>` : ""}
      <div class="card">
        <h2>Event Results <span class="sub">who won, class by class — every number here from one judging panel</span></h2>
        <div class="filters" style="margin:2px 0 8px">
          <select id="bdYearSel" class="ctrl">${years.map(y => `<option value="${y}"${y === season ? " selected" : ""}>${y}</option>`).join("")}</select>
          <select id="bdEvSel" class="ctrl" style="flex:1 1 240px;min-width:0"></select>
        </div>
        <div id="bdEvBody"><div class="loading">Loading…</div></div>
      </div>
      <div class="secdiv">Program Trajectories</div>
      <div class="card">
        <h2>Program Trajectory <span class="sub">best score each season — the real long game, up to ${esc(String(years.length))} years of it</span></h2>
        <div class="filters" style="margin:2px 0 10px">
          <div id="bdSpotPick"></div>
          <div id="bdCmpPick"></div>
          <span id="bdCmpChips" class="bd-chiprow"></span>
        </div>
        <div class="bd-tiles" id="bdSpotTiles"></div>
        <div class="chartwrap" id="bdSpotChart"></div>
        <p class="bd-foot">One point per season — that program's best score of the year, whatever event it came at. Panels differ between events, so read the arc, not the decimals.</p>
      </div>
      <div class="card" style="margin-top:14px">
        <h2 id="bdCapTitle">Caption Strengths <span class="sub">season averages vs the class average</span></h2>
        <div id="bdCapBody"><div class="loading">Loading…</div></div>
      </div>
      <div class="bd-cols2" style="margin-top:14px">
        <div class="card"><h2>Risers <span class="sub">biggest season-best gains vs last year</span></h2><div id="bdRise"></div></div>
        <div class="card"><h2>Fallers <span class="sub">biggest season-best drops vs last year</span></h2><div id="bdFall"></div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <h2>Season Bests <span class="sub">best score anywhere this season — a guide, not a ranking: panels differ between events</span></h2>
        <div class="filters" id="bdLeadTabs" style="margin:2px 0 8px"></div>
        <div id="bdLeadBody"></div>
      </div>
      ${insightsFoot(insights)}`;

    /* ----- event results board ----- */
    const evSel = document.getElementById("bdEvSel");
    const evBody = document.getElementById("bdEvBody");
    let evList = [];
    function renderEventBody(ev) {
      if (!ev) { evBody.innerHTML = '<div class="empty">No results for this season yet.</div>'; return; }
      const classes = H.sortClasses((ev.classes || []).filter(c => (c.results || []).length).map(c => c.class));
      const byCls = new Map((ev.classes || []).map(c => [c.class, c]));
      const nBands = (ev.classes || []).reduce((a, c) => a + (c.results || []).length, 0);
      evBody.innerHTML = `
        <div class="bd-evhead"><b>${esc(ev.name)}</b>
          <span class="bd-evmeta">${esc(fmtDY(ev.date) || ev.date_display || "")}${ev.location ? " · " + esc(ev.location) : ""} · ${nBands} bands</span></div>
        ${classes.map((cls, ci) => {
          const results = (byCls.get(cls).results || []).slice().sort((a, b) => (a.place || 99) - (b.place || 99));
          const med = median(results.map(r => r.score));
          return `<div class="bd-cls">
            <div class="bd-clsrow"><h3>${esc(cls)}</h3><span class="bd-clsn">${results.length} bands${med != null ? ` · median ${fmtScore(med)}` : ""}</span>
              ${results.length > 3 ? `<button class="tab bd-mini" data-bd-toggle="bdFull_${ci}">Full results ▾</button>` : ""}</div>
            ${podiumHTML(H, results, "score", fmtScore)}
            <div id="bdFull_${ci}" hidden>${resultsTableHTML(H, results, fmtScore)}</div>
          </div>`;
        }).join("") || '<div class="empty">No class results published for this event.</div>'}`;
      evBody.querySelectorAll("[data-bd-toggle]").forEach(btn => btn.onclick = () => {
        const t = document.getElementById(btn.dataset.bdToggle);
        t.hidden = !t.hidden;
        btn.textContent = t.hidden ? "Full results ▾" : "Hide full results ▴";
      });
    }
    async function loadYear(yr) {
      evBody.innerHTML = '<div class="loading">Loading…</div>';
      let evs = [];
      try { evs = await data(`seasons/${yr}.json`); } catch (e) {}
      if (stale()) return;
      evList = (evs || []).filter(ev => (ev.classes || []).some(c => (c.results || []).length))
        .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
      evSel.innerHTML = evList.map((ev, i) =>
        `<option value="${i}">${esc(fmtD(ev.date))} · ${esc(ev.name)}</option>`).join("") || "<option>No scored events</option>";
      const last = evList.length - 1;
      evSel.value = String(last);
      renderEventBody(evList[last]);
    }
    document.getElementById("bdYearSel").onchange = e => loadYear(+e.target.value);
    evSel.onchange = () => renderEventBody(evList[+evSel.value]);
    loadYear(season);

    /* ----- program trajectory + tiles + captions ----- */
    const spotKey = cfg.ns + "bd-spot";
    const latestWinner = (() => {
      for (const cls of H.sortClasses(Object.keys(rk.standings || {}))) {
        const rows = (rk.standings[cls] || {}).rows || [];
        if (rows.length) return rows[0].corps;
      }
      return null;
    })();
    let spot = store.get(spotKey);
    if (!spot || !idxMap.has(spot)) spot = (H.FAVS.list() || []).find(n => idxMap.has(n)) || latestWinner || (index[0] && index[0].name);
    let compares = [];

    const pickOpts = (index || []).slice().sort((a, b) => (b.seasons || 0) - (a.seasons || 0))
      .map(c => ({ name: c.name, hint: `${c.seasons || 0} season${c.seasons === 1 ? "" : "s"}${c.best != null ? ` · best ${num1(c.best)}` : ""}` }));

    function rowFor(name) {
      for (const cls of Object.keys(rk.standings || {})) {
        const r = ((rk.standings[cls] || {}).rows || []).find(x => x.corps === name);
        if (r) return { ...r, cls, n: (rk.standings[cls].rows || []).length };
      }
      return null;
    }
    function drawSpot() {
      const chips = document.getElementById("bdCmpChips");
      chips.innerHTML = compares.map(n => `<span class="bd-chip"><span class="sw" style="background:${colorOf(n)}"></span>${esc(n)}<button type="button" data-rm="${qa(esc(n))}" aria-label="Remove">×</button></span>`).join("");
      chips.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { compares = compares.filter(n => n !== b.dataset.rm); drawSpot(); });

      const names = [spot, ...compares].filter(n => idxMap.has(n));
      const series = names.map(n => ({
        name: n, color: colorOf(n),
        points: (idxMap.get(n).series || []).filter(e => e[1] != null).map(e => ({ x: e[0], y: e[1] })),
      })).filter(s => s.points.length);
      const chartEl = document.getElementById("bdSpotChart");
      if (!series.length) chartEl.innerHTML = '<div class="empty">No scored seasons on record yet.</div>';
      else CCViz.lineChart(chartEl, { linearX: true, series, height: 320, yFmt: v => v.toFixed(1), xFmt: v => String(Math.round(v)) });

      const c = idxMap.get(spot);
      const tiles = document.getElementById("bdSpotTiles");
      if (!c) { tiles.innerHTML = ""; return; }
      const bestE = (c.series || []).filter(e => e[1] != null).slice().sort((a, b) => b[1] - a[1])[0];
      const row = rowFor(spot);
      let ctxVal = "—", ctxSub = "didn't compete this season";
      if (row) {
        ctxVal = `${ORD(row.rank)}<small> of ${row.n}</small>`;
        const dist = insights && insights.class_dist && insights.class_dist[row.cls] && insights.class_dist[row.cls][String(season)];
        const med = dist ? dist.median : median(((rk.standings[row.cls] || {}).rows || []).map(r => r.high != null ? r.high : r.score));
        const sc = row.high != null ? row.high : row.score;
        ctxSub = `${esc(row.cls)}${med != null && sc != null ? ` · ${sc >= med ? "+" : "−"}${Math.abs(sc - med).toFixed(1)} vs class median` : ""}`;
      }
      tiles.innerHTML = `
        <div class="tile"><div class="label">Seasons on record</div><div class="value">${c.seasons || 0}</div><div class="sub">since ${c.first || "—"}</div></div>
        <div class="tile"><div class="label">All-time best</div><div class="value">${bestE ? num1(bestE[1]) : "—"}</div><div class="sub">${bestE ? `${bestE[0]}${bestE[2] ? " · " + esc(bestE[2]) : ""}` : "no scores yet"}</div></div>
        <div class="tile"><div class="label">${esc(String(season))} best</div><div class="value">${row && row.high != null ? num1(row.high) : "—"}</div><div class="sub">${row && row.high_event ? esc(row.high_event) : row ? "" : "no outings"}</div></div>
        <div class="tile"><div class="label">In class</div><div class="value">${ctxVal}</div><div class="sub">${ctxSub}</div></div>`;
      drawCaptions();
    }

    let capData = null; // {rows, cols} once fetched
    async function drawCaptions() {
      const body = document.getElementById("bdCapBody");
      if (!body) return;
      if (!capData) {
        let rows = [], cols = [];
        try {
          const [cidx, crows] = await Promise.all([data("captions/index.json"), data(`captions/${season}.json`)]);
          cols = cidx.cols || [];
          rows = crows || [];
        } catch (e) {}
        if (stale()) return;
        capData = { rows, cols };
      }
      const title = document.getElementById("bdCapTitle");
      const { rows, cols } = capData;
      const iCorps = cols.indexOf("corps"), iCls = cols.indexOf("class");
      const mine = iCorps >= 0 ? rows.filter(r => r[iCorps] === spot) : [];
      if (!mine.length) {
        title.innerHTML = `Caption Strengths <span class="sub">season averages vs the class average</span>`;
        body.innerHTML = `<div class="empty">No ${esc(String(season))} caption recaps for ${esc(spot || "this band")} yet — recaps land as they're scraped.</div>`;
        return;
      }
      const cls = mine[mine.length - 1][iCls];
      const prof = captionProfile(rows, cols, spot, cls);
      title.innerHTML = `Caption Strengths <span class="sub">${esc(spot)} vs the ${esc(cls)} average · ${esc(String(season))} recaps</span>`;
      if (!prof.length) { body.innerHTML = '<div class="empty">Caption sheets for this class haven\'t been scraped yet.</div>'; return; }
      const scale = Math.max(0.5, ...prof.map(p => Math.abs(p.diff)));
      body.innerHTML = prof.map(p => {
        const w = Math.abs(p.diff) / scale * 48;
        const dirCls = Math.abs(p.diff) < 0.05 ? "flat" : p.diff > 0 ? "up" : "down";
        return `<div class="bd-div">
          <span class="lbl">${esc(p.label)}<small>${esc(`${p.band.toFixed(2)} vs ${p.avg.toFixed(2)} avg`)}</small></span>
          <span class="bd-divtrack"><span class="bd-divbar ${p.diff >= 0 ? "up" : "down"}" style="width:${w.toFixed(1)}%"></span></span>
          <span class="val ${dirCls}">${p.diff > 0 ? "+" : ""}${p.diff.toFixed(2)}</span>
        </div>`;
      }).join("") + `<div class="bd-foot">Averages across every scraped ${esc(String(season))} recap — positive bars are where ${esc(spot)} outscores the typical ${esc(cls)} band. Captions are the one place cross-event comparison has a denominator: the whole class.</div>`;
    }

    typeahead(document.getElementById("bdSpotPick"), {
      placeholder: "Spotlight a band…", options: pickOpts, value: spot, favs: H.FAVS,
      onPick: n => { spot = n; store.set(spotKey, n); drawSpot(); },
    });
    let cmpTA = null;
    cmpTA = typeahead(document.getElementById("bdCmpPick"), {
      placeholder: "+ Compare a program…", options: pickOpts, value: "", favs: H.FAVS,
      onPick: n => {
        if (n !== spot && !compares.includes(n) && compares.length < 5) compares.push(n);
        if (cmpTA) cmpTA.set("");
        drawSpot();
      },
    });
    drawSpot();

    /* ----- risers & fallers ----- */
    const yoy = (insights && Array.isArray(insights.yoy) && insights.yoy.length
      ? insights.yoy.slice().sort((a, b) => b.delta - a.delta)
      : computeYoY(index, season));
    document.getElementById("bdRise").innerHTML = yoyListHTML(H, yoy.filter(m => m.delta > 0).slice(0, 6), num1);
    document.getElementById("bdFall").innerHTML = yoyListHTML(H, yoy.filter(m => m.delta < 0).slice(-6).reverse(), num1);

    /* ----- season bests per class ----- */
    const leadClasses = H.sortClasses(Object.keys(rk.standings || {}).filter(c => ((rk.standings[c] || {}).rows || []).length));
    const leadTabs = document.getElementById("bdLeadTabs");
    const leadBody = document.getElementById("bdLeadBody");
    function drawLeaders(cls) {
      const rows = ((rk.standings[cls] || {}).rows || []).slice()
        .sort((a, b) => ((b.high != null ? b.high : b.score) || 0) - ((a.high != null ? a.high : a.score) || 0));
      leadBody.innerHTML = rows.length ? `<div class="tscroll"><table class="t"><thead><tr>
          <th>#</th><th>Band</th><th class="num">Season best</th><th>At</th><th class="num m-hide">Shows</th></tr></thead><tbody>
        ${rows.map((r, i) => `<tr${H.FAVS.has(r.corps) ? ' class="favrow"' : ""}>
          <td class="rank">${i + 1}</td>
          <td><span class="corpscell">${H.corpsLogo(r.corps, 24)}<span class="corpscell-body"><span class="corpscell-name">${H.corpsLink(r.corps)}</span></span></span></td>
          <td class="num score">${fmtScore(r.high != null ? r.high : r.score)}</td>
          <td style="color:var(--muted);font-size:12.5px">${esc(r.high_event || r.event || "")}${r.high_date || r.date ? ` · ${esc(fmtD(r.high_date || r.date))}` : ""}</td>
          <td class="num m-hide">${r.outings != null ? r.outings : "—"}</td></tr>`).join("")}
        </tbody></table></div>` : '<div class="empty">No scores in this class yet.</div>';
      collapseRows(leadBody.querySelector("tbody"), 10, cfg.terms.plural, H.FAVS);
    }
    if (leadClasses.length) {
      leadTabs.innerHTML = tabsHTML(leadClasses.map((c, i) => ({ key: c, label: c, on: !i })), "bd-lead");
      wireTabs(leadTabs, "bd-lead", drawLeaders);
      drawLeaders(leadClasses[0]);
    } else {
      leadTabs.hidden = true;
      leadBody.innerHTML = `<div class="empty">No scores yet for ${esc(String(season))} — check back after the first regional.</div>`;
    }
  }

  /* ================================================================
     SHAPE "rating" — UIL. No point scores exist and averaging Division
     ratings is meaningless, so the board is distributions and streaks:
     the statewide rating mix over the years, a band's rating history as
     a heat strip with Superior streaks, region leaderboards by share of
     Division I, and State Championship placements. */
  async function renderRating(ctx) {
    const { app, data, stale, cfg } = ctx;
    const H = ctx.helpers;
    const esc = H.esc;
    const [rk, index, insights] = await Promise.all([
      data("rankings.json"),
      data("corps_index.json").catch(() => []),
      data("insights.json").catch(() => null),
    ]);
    if (stale()) return;
    await H.ensureLogos();
    if (stale()) return;

    const season = rk.season || (insights && insights.latest_year) || new Date().getFullYear();
    const idxMap = new Map((index || []).map(c => [c.name, c]));

    const fromInsights = !!(insights && insights.ratings && Object.keys(insights.ratings).length);
    const DIST = fromInsights ? insights.ratings : ratingDistFromIndex(index);
    const distClasses = H.sortClasses(Object.keys(DIST));
    const distSource = fromInsights
      ? "Counting every published Division rating."
      : "Counting each band's best rating of the year.";

    app.innerHTML = `
      <h1 class="page">${esc(String(season))} Scoreboard</h1>
      ${cfg.scoreNote ? `<p class="kicker" style="margin:-6px 2px 12px">${esc(cfg.scoreNote)}</p>` : ""}
      <div class="card">
        <h2>Texas, Rated <span class="sub">share of bands earning each Division rating, year by year — a view nobody else publishes</span></h2>
        <div class="filters" style="margin:2px 0 8px" id="bdDistTabs"></div>
        <div class="chartwrap" id="bdDistChart"></div>
        <div class="legend">${[1, 2, 3, 4, 5].map(r =>
          `<span class="key"><span class="bd-swatch" style="background:${ratingColor(r)}"></span>${ROMAN[r]} — ${RATING_LABELS[r]}</span>`).join("")}</div>
        <p class="bd-foot">${esc(distSource)} Division I is the bottom band of each bar — the green base is the share of Superiors.</p>
      </div>
      <div class="secdiv">Band History</div>
      <div class="card">
        <h2>Rating History <span class="sub">every published marching rating, and the Superior streaks that matter</span></h2>
        <div class="filters" style="margin:2px 0 10px"><div id="bdBandPick"></div></div>
        <div class="bd-tiles" id="bdBandTiles"></div>
        <div id="bdBandStreaks" class="bd-streaks"></div>
        <div id="bdBandStrip"></div>
        <p class="bd-foot">A streak is calendar-consecutive Superior (Division I) marching ratings — a year with no published rating breaks it. Marching only: UIL Sweepstakes also requires concert and sight-reading Superiors, which this circuit feed doesn't carry.</p>
      </div>
      <div class="bd-cols2" style="margin-top:14px">
        <div class="card">
          <h2>Region Leaderboard <span class="sub">share of Division I ratings · ${esc(String(season))} region contests</span></h2>
          <div id="bdRegions"><div class="loading">Loading…</div></div>
        </div>
        <div class="card">
          <h2 id="bdStateTitle">State Championships</h2>
          <div id="bdState"><div class="loading">Loading…</div></div>
        </div>
      </div>
      ${insightsFoot(insights)}`;

    /* ----- statewide distribution ----- */
    const distChart = document.getElementById("bdDistChart");
    let distCls = distClasses.includes(cfg.classOrder && cfg.classOrder[0]) ? cfg.classOrder[0] : distClasses[0];
    let distAll = false; // false = last 20 years
    function distYears() {
      const ys = new Set();
      const src = distCls === "*" ? Object.values(DIST) : [DIST[distCls] || {}];
      src.forEach(cls => Object.keys(cls).forEach(y => ys.add(+y)));
      let arr = [...ys].sort((a, b) => a - b);
      if (!distAll && arr.length > 20) arr = arr.slice(-20);
      return arr;
    }
    function distCounts(yr) {
      if (distCls !== "*") return (DIST[distCls] || {})[yr] || (DIST[distCls] || {})[String(yr)];
      const sum = {};
      for (const cls of Object.keys(DIST)) {
        const c = DIST[cls][yr] || DIST[cls][String(yr)] || {};
        for (const r of Object.keys(c)) sum[r] = (sum[r] || 0) + c[r];
      }
      return sum;
    }
    function drawDist() {
      stackedShare(distChart, { years: distYears(), counts: distCounts, height: 300, noun: cfg.terms.plural });
    }
    const distTabs = document.getElementById("bdDistTabs");
    if (distClasses.length) {
      distTabs.innerHTML = tabsHTML(
        [...distClasses.map(c => ({ key: c, label: c, on: c === distCls })), { key: "*", label: "All classes", on: false }],
        "bd-dist") + `<button class="tab bd-mini" id="bdDistSpan" style="margin-left:auto">All years</button>`;
      wireTabs(distTabs, "bd-dist", k => { distCls = k; drawDist(); });
      document.getElementById("bdDistSpan").onclick = e => {
        distAll = !distAll;
        e.target.textContent = distAll ? "Last 20 years" : "All years";
        e.target.classList.toggle("on", distAll);
        drawDist();
      };
      drawDist();
    } else {
      distChart.innerHTML = '<div class="empty">Rating history builds with the next data run.</div>';
    }

    /* ----- band rating history ----- */
    const bandKey = cfg.ns + "bd-band";
    const rated = (index || []).filter(c => (c.series || []).some(e => e[1] != null));
    let featured = null, featStreak = -1;
    for (const c of rated) {
      const st = streakStats(c.series);
      if (st.current > featStreak || (st.current === featStreak && (c.seasons || 0) > ((idxMap.get(featured) || {}).seasons || 0))) {
        featured = c.name; featStreak = st.current;
      }
    }
    let band = store.get(bandKey);
    if (!band || !idxMap.has(band)) band = (H.FAVS.list() || []).find(n => idxMap.has(n)) || featured || (rated[0] && rated[0].name);

    const bandOpts = rated.slice().sort((a, b) => (b.seasons || 0) - (a.seasons || 0))
      .map(c => ({ name: c.name, hint: `${c.first}–${c.last}` }));
    function drawBand() {
      const c = idxMap.get(band);
      const tiles = document.getElementById("bdBandTiles");
      const strip = document.getElementById("bdBandStrip");
      const pills = document.getElementById("bdBandStreaks");
      if (!c) { tiles.innerHTML = ""; strip.innerHTML = '<div class="empty">Pick a band above.</div>'; pills.innerHTML = ""; return; }
      const st = streakStats(c.series);
      const latest = st.latest;
      tiles.innerHTML = `
        <div class="tile"><div class="label">Latest rating</div><div class="value">${latest ? esc(H.score3(latest[1])) : "—"}</div><div class="sub">${latest ? `${latest[0]}${latest[2] ? " · " + esc(latest[2]) : ""}` : ""}</div></div>
        <div class="tile"><div class="label">Superior streak</div><div class="value">${st.current}</div><div class="sub">${st.currentSpan ? `${st.currentSpan[0]}–${st.currentSpan[1]}` : "no active streak"}</div></div>
        <div class="tile"><div class="label">Longest streak</div><div class="value">${st.longest}</div><div class="sub">${st.longestSpan ? `${st.longestSpan[0]}–${st.longestSpan[1]}` : "—"}</div></div>
        <div class="tile"><div class="label">Career Superiors</div><div class="value">${st.superiors}</div><div class="sub">of ${st.rated} rated years</div></div>`;
      let pl = "";
      if (st.current >= 2) pl += `<span class="bd-streakpill">${st.current} straight Superior ratings (${st.currentSpan[0]}–${st.currentSpan[1]})</span>`;
      if (st.longest >= 2 && (!st.currentSpan || st.longestSpan[0] !== st.currentSpan[0])) pl += `<span class="bd-streakpill">Longest run: ${st.longest} (${st.longestSpan[0]}–${st.longestSpan[1]})</span>`;
      pills.innerHTML = pl;
      strip.innerHTML = heatstripHTML(H, c.series, c.first, c.last);
    }
    typeahead(document.getElementById("bdBandPick"), {
      placeholder: `Search ${cfg.terms.plural}…`, options: bandOpts, value: band, favs: H.FAVS,
      onPick: n => { band = n; store.set(bandKey, n); drawBand(); },
    });
    drawBand();

    /* ----- regions + state (from season files; single fetch each) ----- */
    let seasonEvents = [];
    try { seasonEvents = await data(`seasons/${season}.json`); } catch (e) {}
    if (stale()) return;
    const regions = regionAgg(seasonEvents);
    const regHost = document.getElementById("bdRegions");
    if (regions.length) {
      regHost.innerHTML = regions.slice(0, 12).map(r => `<div class="bd-meter">
          <span class="lbl">Region ${r.region}</span>
          <span class="bd-track"><span class="bd-fill" style="width:${(r.share * 100).toFixed(1)}%"></span></span>
          <span class="val">${Math.round(r.share * 100)}% · ${r.sup} of ${r.n}</span>
        </div>`).join("") +
        (regions.length > 12 ? `<div class="bd-foot">${regions.length - 12} more regions with published ratings this season.</div>` : "") +
        `<div class="bd-foot">Every region judges independently — this compares how each region's bands fared on the statewide rating scale, not head-to-head.</div>`;
    } else {
      regHost.innerHTML = `<div class="empty">No region contest ratings for ${esc(String(season))} yet.</div>`;
    }

    const stateHost = document.getElementById("bdState");
    const stateTitle = document.getElementById("bdStateTitle");
    let stateEvents = null, stateYear = season;
    for (let y = season; y > season - 3; y--) {
      let evs = seasonEvents;
      if (y !== season) { try { evs = await data(`seasons/${y}.json`); } catch (e) { evs = []; } }
      if (stale()) return;
      const st = (evs || []).filter(ev => ev.stage === "state" && (ev.classes || []).some(c => (c.results || []).length));
      if (st.length) { stateEvents = st; stateYear = y; break; }
    }
    if (stateEvents) {
      const finals = stateEvents.find(ev => /finals/i.test(ev.name)) || stateEvents[stateEvents.length - 1];
      stateTitle.innerHTML = `State Championships <span class="sub">${esc(String(stateYear))} · ${esc(finals.name)}</span>`;
      const classes = H.sortClasses((finals.classes || []).filter(c => (c.results || []).length).map(c => c.class));
      const byCls = new Map((finals.classes || []).map(c => [c.class, c]));
      stateHost.innerHTML = classes.map((cls, ci) => {
        const rs = (byCls.get(cls).results || []).slice().sort((a, b) => (a.place || 99) - (b.place || 99));
        const top = rs.slice(0, 6), rest = rs.length - top.length;
        return `<div class="bd-cls"><div class="bd-clsrow"><h3>${esc(cls)}</h3><span class="bd-clsn">${rs.length} bands</span>
            ${rest > 0 ? `<button class="tab bd-mini" data-bd-toggle="bdStFull_${ci}">All ${rs.length} ▾</button>` : ""}</div>
          <table class="t">${top.map(r => `<tr><td class="rank">${esc(ORD(r.placement != null ? r.placement : r.place))}</td><td>${H.corpsLink(r.corps)}</td></tr>`).join("")}</table>
          ${rest > 0 ? `<div id="bdStFull_${ci}" hidden><table class="t">${rs.slice(6).map(r =>
            `<tr><td class="rank">${esc(ORD(r.placement != null ? r.placement : r.place))}</td><td>${H.corpsLink(r.corps)}</td></tr>`).join("")}</table></div>` : ""}
        </div>`;
      }).join("") + `<div class="bd-foot">UIL publishes ordinal placements at State — no point scores. Classes alternate State years, so the latest published field is shown.</div>`;
      stateHost.querySelectorAll("[data-bd-toggle]").forEach(btn => btn.onclick = () => {
        const t = document.getElementById(btn.dataset.bdToggle);
        t.hidden = !t.hidden;
        btn.textContent = t.hidden ? btn.textContent.replace("▴", "▾") : btn.textContent.replace("▾", "▴");
      });
    } else {
      stateTitle.innerHTML = `State Championships`;
      stateHost.innerHTML = '<div class="empty">No State Marching Band Championships placements published in the last three seasons.</div>';
    }
  }

  /* ================================================================
     SHAPE "placement" — ISSMA. One State Finals a year, ordinals only:
     the board is finals results by year, a dynasty table, and a band's
     placement history on an inverted axis (1st at the top). */
  async function renderPlacement(ctx) {
    const { app, data, stale, cfg } = ctx;
    const H = ctx.helpers;
    const esc = H.esc;
    const [rk, index, insights, meta] = await Promise.all([
      data("rankings.json"),
      data("corps_index.json").catch(() => []),
      data("insights.json").catch(() => null),
      data("meta.json").catch(() => null),
    ]);
    if (stale()) return;
    await H.ensureLogos();
    if (stale()) return;

    const season = rk.season || (insights && insights.latest_year) || new Date().getFullYear();
    const idxMap = new Map((index || []).map(c => [c.name, c]));
    const years = ((meta && meta.seasons) || []).filter(s => s.events > 0).map(s => s.year).sort((a, b) => b - a);
    if (!years.length) years.push(season);
    const firstYear = years[years.length - 1];

    app.innerHTML = `
      <h1 class="page">${esc(String(season))} Scoreboard</h1>
      ${cfg.scoreNote ? `<p class="kicker" style="margin:-6px 2px 12px">${esc(cfg.scoreNote)}</p>` : ""}
      <div class="card">
        <h2>State Finals <span class="sub">placements by class — ${esc(String(firstYear))} to today</span></h2>
        <div class="filters" style="margin:2px 0 8px">
          <select id="bdYearSel" class="ctrl">${years.map(y => `<option value="${y}"${y === season ? " selected" : ""}>${y}</option>`).join("")}</select>
        </div>
        <div id="bdFinalsBody"><div class="loading">Loading…</div></div>
      </div>
      <div class="secdiv">All-Time</div>
      <div class="card">
        <h2>Dynasties <span class="sub">titles, podiums and finals appearances since ${esc(String(firstYear))}</span></h2>
        <div class="filters" id="bdDynTabs" style="margin:2px 0 8px"></div>
        <div id="bdDynBody"></div>
      </div>
      <div class="card" style="margin-top:14px">
        <h2>Placement History <span class="sub">finals finish by year — 1st at the top</span></h2>
        <div class="filters" style="margin:2px 0 10px"><div id="bdBandPick"></div></div>
        <div class="bd-tiles" id="bdBandTiles"></div>
        <div class="chartwrap" id="bdBandChart"></div>
        <p class="bd-foot">Only published State Finals ordinals — a gap means the band didn't reach (or ISSMA didn't publish) that year's finals.</p>
      </div>
      ${insightsFoot(insights)}`;

    /* ----- finals by year ----- */
    const prevPlace = (name, yr) => {
      const e = idxMap.get(name);
      if (!e) return null;
      const prev = (e.series || []).find(x => x[0] === yr - 1);
      return prev ? prev[1] : null;
    };
    const finalsBody = document.getElementById("bdFinalsBody");
    async function loadFinals(yr) {
      finalsBody.innerHTML = '<div class="loading">Loading…</div>';
      let evs = [];
      try { evs = await data(`seasons/${yr}.json`); } catch (e) {}
      if (stale()) return;
      const scored = (evs || []).filter(ev => (ev.classes || []).some(c => (c.results || []).length));
      if (!scored.length) { finalsBody.innerHTML = `<div class="empty">No published finals for ${yr}.</div>`; return; }
      let uid = 0;
      finalsBody.innerHTML = scored.map(ev => `
        <div class="bd-evhead" style="margin-top:10px"><b>${esc(ev.name)}</b>
          <span class="bd-evmeta">${esc(fmtDY(ev.date) || ev.date_display || "")}${ev.location ? " · " + esc(ev.location) : ""}</span></div>
        ${H.sortClasses((ev.classes || []).filter(c => (c.results || []).length).map(c => c.class)).map(cls => {
          const rs = (ev.classes.find(c => c.class === cls).results || []).slice()
            .sort((a, b) => (a.place || 99) - (b.place || 99));
          const id = `bdPl_${uid++}`;
          return `<div class="bd-cls">
            <div class="bd-clsrow"><h3>${esc(cls)}</h3><span class="bd-clsn">${rs.length} bands</span>
              ${rs.length > 3 ? `<button class="tab bd-mini" data-bd-toggle="${id}">Full results ▾</button>` : ""}</div>
            ${podiumHTML(H, rs, "placement")}
            <div id="${id}" hidden><table class="t"><thead><tr><th>#</th><th>Band</th><th class="num">vs last year</th></tr></thead><tbody>
              ${rs.map(r => {
                const p = r.placement != null ? r.placement : r.place;
                const prev = prevPlace(r.corps, yr);
                return `<tr${H.FAVS.has(r.corps) ? ' class="favrow"' : ""}><td class="rank">${esc(ORD(p))}</td><td>${H.corpsLink(r.corps)}</td>
                  <td class="num">${prev == null ? '<span class="delta flat">—</span>' : deltaPill(prev - p, 0)}</td></tr>`;
              }).join("")}
            </tbody></table></div>
          </div>`;
        }).join("")}`).join("");
      finalsBody.querySelectorAll("[data-bd-toggle]").forEach(btn => btn.onclick = () => {
        const t = document.getElementById(btn.dataset.bdToggle);
        t.hidden = !t.hidden;
        btn.textContent = t.hidden ? "Full results ▾" : "Hide full results ▴";
      });
    }
    document.getElementById("bdYearSel").onchange = e => loadFinals(+e.target.value);
    loadFinals(season);

    /* ----- dynasty table ----- */
    const dynClasses = H.sortClasses([...new Set((index || []).flatMap(c => (c.series || []).map(e => e[2]).filter(Boolean)))]);
    const dynTabs = document.getElementById("bdDynTabs");
    const dynBody = document.getElementById("bdDynBody");
    function drawDyn(cls) {
      const rows = dynastyFromIndex(index, cls === "*" ? null : cls).filter(r => r.apps > 0);
      dynBody.innerHTML = rows.length ? `<div class="tscroll"><table class="t"><thead><tr>
          <th>#</th><th>Band</th><th class="num">Titles</th><th class="num">Podiums</th><th class="num">Finals</th><th class="num m-hide">Best</th><th class="m-hide">Span</th></tr></thead><tbody>
        ${rows.map((r, i) => `<tr${H.FAVS.has(r.corps) ? ' class="favrow"' : ""}>
          <td class="rank">${i + 1}</td>
          <td><span class="corpscell">${H.corpsLogo(r.corps, 24)}<span class="corpscell-body"><span class="corpscell-name">${H.corpsLink(r.corps)}</span></span></span></td>
          <td class="num score">${r.titles || ""}${r.titles ? "" : "—"}</td>
          <td class="num">${r.podiums}</td>
          <td class="num">${r.apps}</td>
          <td class="num m-hide">${esc(ORD(r.best))}</td>
          <td class="m-hide" style="color:var(--muted);font-variant-numeric:tabular-nums">${r.first}–${r.last}</td></tr>`).join("")}
        </tbody></table></div>` : '<div class="empty">No finals history in this class yet.</div>';
      collapseRows(dynBody.querySelector("tbody"), 12, cfg.terms.plural, H.FAVS);
    }
    dynTabs.innerHTML = tabsHTML(
      [{ key: "*", label: "All classes", on: true }, ...dynClasses.map(c => ({ key: c, label: c, on: false }))],
      "bd-dyn");
    wireTabs(dynTabs, "bd-dyn", drawDyn);
    drawDyn("*");

    /* ----- band placement history ----- */
    const bandKey = cfg.ns + "bd-band";
    const withHist = (index || []).filter(c => (c.series || []).length);
    const topDyn = dynastyFromIndex(index, null)[0];
    let band = store.get(bandKey);
    if (!band || !idxMap.has(band)) band = (H.FAVS.list() || []).find(n => idxMap.has(n)) || (topDyn && topDyn.corps) || (withHist[0] && withHist[0].name);
    const bandOpts = withHist.slice().sort((a, b) => (b.n || 0) - (a.n || 0))
      .map(c => ({ name: c.name, hint: `${c.n} finals${c.best_placement != null ? ` · best ${ORD(c.best_placement)}` : ""}` }));
    function drawBand() {
      const c = idxMap.get(band);
      const tiles = document.getElementById("bdBandTiles");
      const chartEl = document.getElementById("bdBandChart");
      if (!c) { tiles.innerHTML = ""; chartEl.innerHTML = '<div class="empty">Pick a band above.</div>'; return; }
      const s = (c.series || []).filter(e => e[1] != null);
      const titles = s.filter(e => e[1] === 1).length;
      const best = s.length ? Math.min(...s.map(e => e[1])) : null;
      const bestYears = s.filter(e => e[1] === best).map(e => e[0]);
      const latest = s[s.length - 1];
      tiles.innerHTML = `
        <div class="tile"><div class="label">State titles</div><div class="value">${titles}</div><div class="sub">${titles ? esc(s.filter(e => e[1] === 1).map(e => e[0]).join(", ")) : "—"}</div></div>
        <div class="tile"><div class="label">Finals appearances</div><div class="value">${s.length}</div><div class="sub">since ${c.first || "—"}</div></div>
        <div class="tile"><div class="label">Best finish</div><div class="value">${best != null ? esc(ORD(best)) : "—"}</div><div class="sub">${bestYears.length ? esc(bestYears.slice(-3).join(", ")) : ""}</div></div>
        <div class="tile"><div class="label">Latest</div><div class="value">${latest ? esc(ORD(latest[1])) : "—"}</div><div class="sub">${latest ? `${latest[0]}${latest[2] ? " · " + esc(latest[2]) : ""}` : ""}</div></div>`;
      placementChart(chartEl, { points: s.map(e => ({ x: e[0], y: e[1], cls: e[2] })), color: colorOf(band), height: 280 });
    }
    typeahead(document.getElementById("bdBandPick"), {
      placeholder: `Search ${cfg.terms.plural}…`, options: bandOpts, value: band, favs: H.FAVS,
      onPick: n => { band = n; store.set(bandKey, n); drawBand(); },
    });
    drawBand();
  }

  /* ================================================================
     SHAPE "history" — WGI. No published score feed (WGI posts live scores
     behind its directors' portal), but the championship record is real and
     deep. Centerpiece: the champions honor roll by class, dynasty counts,
     and the official published schedule. Computed entirely from
     champions.json + corps_index.json + upcoming.json — no insights.json. */
  async function renderHistory(ctx) {
    const { app, data, stale, cfg } = ctx;
    const H = ctx.helpers;
    const esc = H.esc;
    const [champions, index, upcoming] = await Promise.all([
      data("champions.json").catch(() => ({})),
      data("corps_index.json").catch(() => []),
      data("upcoming.json").catch(() => []),
    ]);
    if (stale()) return;
    await H.ensureLogos();
    if (stale()) return;

    const champYears = Object.keys(champions || {}).map(Number).filter(y => y > 0).sort((a, b) => a - b);
    const latestYear = champYears[champYears.length - 1];
    const allClasses = H.sortClasses([...new Set(champYears.flatMap(y => Object.keys(champions[y] || {})))]);
    const totalTitles = champYears.reduce((a, y) => a + Object.keys(champions[y] || {}).length, 0);
    const fmtScore = H.score3;

    app.innerHTML = `
      <h1 class="page">Championship History</h1>
      <div class="notice" style="margin:0 0 14px">
        WGI publishes live scores through its directors-only portal, so Cadence shows what is
        openly published: the championship record and the official event schedule.
        Score coverage is pending permission from WGI.
      </div>
      ${champYears.length ? `<div class="bd-tiles" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="tile"><div class="label">Championship seasons</div><div class="value">${champYears.length}</div><div class="sub">${champYears[0]}–${latestYear}</div></div>
        <div class="tile"><div class="label">Classes contested</div><div class="value">${allClasses.length}</div><div class="sub">at World Championships</div></div>
        <div class="tile"><div class="label">Titles on record</div><div class="value">${totalTitles}</div><div class="sub">gold medals awarded</div></div>
        <div class="tile"><div class="label">${esc(cfg.terms.plural.charAt(0).toUpperCase() + cfg.terms.plural.slice(1))} tracked</div><div class="value">${(index || []).length}</div><div class="sub">with profile pages</div></div>
      </div>` : ""}
      ${latestYear ? `<div class="card">
        <h2>Reigning Champions <span class="sub">${esc(String(latestYear))} World Championships</span></h2>
        <div class="champ-grid">${allClasses.map(cls => {
          const c = champions[latestYear] && champions[latestYear][cls];
          if (!c || !c.corps) return "";
          return `<div class="champ-tile">${H.corpsLogo(c.corps, 34)}<span class="champ-tile-t">
            <span class="champ-tile-cls">${esc(cls)}</span><b>${H.corpsLink(c.corps)}</b>
            ${c.score != null ? `<span class="champ-tile-s">${fmtScore(c.score)}</span>` : ""}</span></div>`;
        }).join("")}</div>
      </div>` : ""}
      <div class="card" style="margin-top:14px">
        <h2>Champions Honor Roll <span class="sub">every World Champion on record, class by class</span></h2>
        <div class="filters" id="bdRollTabs" style="margin:2px 0 8px"></div>
        <div id="bdRollBody"></div>
      </div>
      <div class="card" style="margin-top:14px">
        <h2>Dynasties <span class="sub">most World Championship titles</span></h2>
        <div class="filters" id="bdDynTabs" style="margin:2px 0 8px"></div>
        <div id="bdDynBody"></div>
      </div>
      <div class="card" style="margin-top:14px">
        <h2 id="bdSchedTitle">Official Schedule</h2>
        <div id="bdSched"></div>
      </div>`;

    /* ----- honor roll ----- */
    const rollTabs = document.getElementById("bdRollTabs");
    const rollBody = document.getElementById("bdRollBody");
    let rollAsc = false;
    let rollCls = allClasses[0];
    function drawRoll() {
      if (!rollCls) { rollBody.innerHTML = '<div class="empty">The champions record builds with the next data run.</div>'; return; }
      let rows = titleRows(champions, rollCls);
      if (rollAsc) rows = rows.slice().reverse();
      const counts = new Map(titleCounts(champions, rollCls).map(r => [r.corps, r.titles]));
      rollBody.innerHTML = rows.length ? `<div class="tscroll"><table class="t"><thead><tr>
          <th>Year</th><th>Champion</th><th class="num">Score</th><th class="num m-hide">Title #</th></tr></thead><tbody>
        ${rows.map(r => {
          const nth = rows.filter(x => x.corps === r.corps && x.year <= r.year).length;
          return `<tr${H.FAVS.has(r.corps) ? ' class="favrow"' : ""}>
            <td class="rank" style="width:52px">${r.year}</td>
            <td><span class="corpscell">${H.corpsLogo(r.corps, 24)}<span class="corpscell-body"><span class="corpscell-name">${H.corpsLink(r.corps)}${r.year === latestYear ? ' <span class="classbadge">reigning</span>' : ""}</span></span></span></td>
            <td class="num score">${r.score != null ? fmtScore(r.score) : "—"}</td>
            <td class="num m-hide" style="color:var(--muted)">${nth} of ${counts.get(r.corps) || nth}</td></tr>`;
        }).join("")}
        </tbody></table></div>` : `<div class="empty">No champions on record for ${esc(rollCls)} yet.</div>`;
      collapseRows(rollBody.querySelector("tbody"), 12, "champions", H.FAVS);
    }
    if (allClasses.length) {
      rollTabs.innerHTML = tabsHTML(allClasses.map((c, i) => ({ key: c, label: c, on: !i })), "bd-roll") +
        `<button class="tab bd-mini" id="bdRollOrder" style="margin-left:auto">Oldest first</button>`;
      wireTabs(rollTabs, "bd-roll", k => { rollCls = k; drawRoll(); });
      document.getElementById("bdRollOrder").onclick = e => {
        rollAsc = !rollAsc;
        e.target.textContent = rollAsc ? "Newest first" : "Oldest first";
        drawRoll();
      };
    } else rollTabs.hidden = true;
    drawRoll();

    /* ----- dynasties ----- */
    const dynTabs = document.getElementById("bdDynTabs");
    const dynBody = document.getElementById("bdDynBody");
    function drawDyn(cls) {
      const rows = titleCounts(champions, cls === "*" ? null : cls);
      dynBody.innerHTML = rows.length ? `<div class="tscroll"><table class="t"><thead><tr>
          <th>#</th><th>${esc(cfg.terms.singular.charAt(0).toUpperCase() + cfg.terms.singular.slice(1))}</th><th class="num">Titles</th><th class="num m-hide">First</th><th class="num">Latest</th></tr></thead><tbody>
        ${rows.map((r, i) => `<tr${H.FAVS.has(r.corps) ? ' class="favrow"' : ""}>
          <td class="rank">${i + 1}</td>
          <td><span class="corpscell">${H.corpsLogo(r.corps, 24)}<span class="corpscell-body"><span class="corpscell-name">${H.corpsLink(r.corps)}</span></span></span></td>
          <td class="num score">${r.titles}</td>
          <td class="num m-hide">${r.first}</td>
          <td class="num">${r.latest}</td></tr>`).join("")}
        </tbody></table></div>` : '<div class="empty">No titles on record yet.</div>';
      collapseRows(dynBody.querySelector("tbody"), 10, cfg.terms.plural, H.FAVS);
    }
    dynTabs.innerHTML = tabsHTML(
      [{ key: "*", label: "All classes", on: true }, ...allClasses.map(c => ({ key: c, label: c, on: false }))],
      "bd-dyn");
    wireTabs(dynTabs, "bd-dyn", drawDyn);
    drawDyn("*");

    /* ----- official schedule ----- */
    const schedHost = document.getElementById("bdSched");
    const schedTitle = document.getElementById("bdSchedTitle");
    const evs = (upcoming || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (evs.length) {
      const yr = String(evs[0].date || "").slice(0, 4);
      schedTitle.innerHTML = `Official Schedule <span class="sub">${esc(yr)} season, as published by WGI</span>`;
      const shown = evs.slice(0, 12);
      schedHost.innerHTML = shown.map(ev => `<div class="upitem"><b>${esc(fmtDY(ev.date) || ev.date_display || "")}</b> — ${esc(ev.name)}${ev.location ? `<span class="lineup">${esc(ev.location)}</span>` : ""}</div>`).join("") +
        (evs.length > shown.length ? `<div class="expandwrap"><button class="tab" id="bdSchedMore">Show All ${evs.length} Events ▾</button></div>` : "");
      const more = document.getElementById("bdSchedMore");
      if (more) more.onclick = () => {
        schedHost.innerHTML = evs.map(ev => `<div class="upitem"><b>${esc(fmtDY(ev.date) || ev.date_display || "")}</b> — ${esc(ev.name)}${ev.location ? `<span class="lineup">${esc(ev.location)}</span>` : ""}</div>`).join("");
      };
    } else {
      schedTitle.innerHTML = "Official Schedule";
      schedHost.innerHTML = '<div class="empty">The next season\'s schedule lands here when WGI publishes it.</div>';
    }
  }

  /* ---------- entry point ---------- */
  async function render(ctx) {
    const { app, stale, shape } = ctx;
    app.innerHTML = '<div class="loading">Loading…</div>';
    try {
      if (shape === "event") return await renderEvent(ctx);
      if (shape === "rating") return await renderRating(ctx);
      if (shape === "placement") return await renderPlacement(ctx);
      if (shape === "history") return await renderHistory(ctx);
      throw new Error(`unknown board shape "${shape}"`);
    } catch (e) {
      if (!stale()) {
        app.innerHTML = `<div class="card"><div class="empty">Couldn't load this view (${ctx.helpers.esc(e && e.message || e)}). Data may be mid-update — try again in a minute.</div></div>`;
      }
    }
  }

  window.CadBoard = {
    render,
    /* pure pieces exposed for the offline test harness */
    _internals: {
      computeYoY, ratingDistFromIndex, streakStats, regionAgg, dynastyFromIndex,
      captionProfile, titleRows, titleCounts, median, ORD,
      podiumHTML, resultsTableHTML, heatstripHTML, yoyListHTML,
    },
  };
})();
