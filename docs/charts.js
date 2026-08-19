/* Cadence chart helpers — hand-rolled SVG per house dataviz spec:
   2px lines, >=8px end markers with 2px surface rings, hairline solid grid,
   crosshair + single tooltip listing every series, legend always for >=2 series. */
(function () {
  const themeVar = name => (getComputedStyle(document.documentElement).getPropertyValue(name) || "").trim();
  const CH = () => ({
    grid: themeVar("--ch-grid") || CH().grid,
    base: themeVar("--ch-base") || CH().base,
    label: themeVar("--ch-label") || CH().label,
    ink: themeVar("--ch-ink") || CH().ink,
    halo: themeVar("--ch-halo") || CH().halo,
    cross: themeVar("--ch-cross") || CH().cross,
  });
  const NS = "http://www.w3.org/2000/svg";
  const PALETTE = ["#e8590c", "#1971c2", "#2f9e44", "#6741d9", "#c2255c", "#0c8599", "#a61e4d", "#495057"];

  // Some corps identities are very dark (Phantom graphite, Blue Devils navy,
  // Boston crimson) and all but vanish on the dark chart surface. In dark mode,
  // lift a too-dark line color just enough to clear a legible-contrast floor —
  // the minimum whitening keeps as much of the hue as possible. Light mode and
  // already-bright colors pass through untouched. Applied once at series setup so
  // the line, end marker, tooltip swatch and legend all use the same color.
  const _cDark = () => {
    const t = document.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    try { return matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) { return false; }
  };
  const _cHx = s => { s = String(s || "").replace("#", ""); if (s.length === 3) s = [...s].map(c => c + c).join(""); const n = parseInt(s, 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const _cRgb = a => "#" + a.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("");
  const _cMix = (a, b, t) => a.map((c, i) => c * (1 - t) + b[i] * t);
  const _cLum = a => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(a[0]) + 0.7152 * f(a[1]) + 0.0722 * f(a[2]); };
  function lineColor(hex) {
    if (!hex || !_cDark()) return hex;
    const c = _cHx(hex);
    if (_cLum(c) >= 0.32) return hex; // bright enough already
    let t = 0, out = c;
    while (_cLum(out) < 0.32 && t < 0.85) { t += 0.1; out = _cMix(c, [255, 255, 255], t); }
    return _cRgb(out);
  }

  function el(name, attrs, parent) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function niceTicks(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    let step = mag;
    for (const m of [1, 2, 2.5, 5, 10]) if (step0 <= m * mag) { step = m * mag; break; }
    const lo = Math.floor(min / step) * step;
    const ticks = [];
    for (let v = lo; v <= max + 1e-9; v += step) if (v >= min - 1e-9) ticks.push(+v.toFixed(6));
    return ticks;
  }

  const tooltip = () => document.getElementById("tooltip");

  function showTip(html, x, y, touch) {
    const t = tooltip();
    t.innerHTML = html;
    t.hidden = false;
    const r = t.getBoundingClientRect();
    let left = x + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    let top;
    if (touch) {
      // lift the whole box a clear gap ABOVE the fingertip so the finger never
      // covers it; measured height keeps the gap right whatever the box size.
      // Only drop below the finger when there's no room up top.
      const GAP = 46;
      top = y - r.height - GAP;
      if (top < 6) top = y + GAP;
    } else {
      top = y + 14;
      if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    }
    t.style.left = Math.max(6, left) + "px";
    t.style.top = Math.max(6, top) + "px";
  }
  function hideTip() { tooltip().hidden = true; }

  // Scrubbing on a chart's transparent hover overlay.
  //   Mouse/pen: hover-drag reads the value at each x (a drag isn't a page
  //   scroll on desktop, so pointer events are enough).
  //   Touch: lock to the dominant axis on the first finger move — a mostly-
  //   horizontal drag scrubs the crosshair (and we preventDefault so the page
  //   doesn't also pan), while a mostly-vertical swipe is left alone so the
  //   page scrolls normally. Raw touch events + preventDefault give reliable
  //   direction control that touch-action alone doesn't on iOS.
  function bindScrub(hover, cross, moveTo) {
    const hide = () => { cross.setAttribute("opacity", 0); hideTip(); };
    const notTouch = evt => evt.pointerType !== "touch";
    hover.addEventListener("pointerdown", evt => {
      if (!notTouch(evt)) return;
      try { hover.setPointerCapture(evt.pointerId); } catch (e) {}
      moveTo(evt);
    });
    hover.addEventListener("pointermove", evt => { if (notTouch(evt)) moveTo(evt); });
    hover.addEventListener("pointerup", evt => { if (notTouch(evt)) hide(); });
    hover.addEventListener("pointercancel", evt => { if (notTouch(evt)) hide(); });
    hover.addEventListener("pointerleave", evt => { if (notTouch(evt)) hide(); });

    let sx = 0, sy = 0, mode = 0; // 0 undecided · 1 scrub · -1 let page scroll
    hover.addEventListener("touchstart", e => {
      const t = e.touches[0]; if (!t) return;
      sx = t.clientX; sy = t.clientY; mode = 0;
    }, { passive: true });
    hover.addEventListener("touchmove", e => {
      const t = e.touches[0]; if (!t) return;
      if (mode === 0) {
        const dx = Math.abs(t.clientX - sx), dy = Math.abs(t.clientY - sy);
        if (dx < 7 && dy < 7) return;              // wait until the intent is clear
        mode = dx > dy ? 1 : -1;
      }
      if (mode === 1) {
        e.preventDefault();                        // own the gesture — no page pan while scrubbing
        moveTo({ clientX: t.clientX, clientY: t.clientY, pointerType: "touch" });
      }
    }, { passive: false });
    const end = () => { if (mode === 1) hide(); mode = 0; };
    hover.addEventListener("touchend", end);
    hover.addEventListener("touchcancel", end);
  }
  // keep the tooltip clear of the fingertip on touch (mouse points precisely)
  const isTouch = evt => evt.pointerType === "touch";

  function esc(s) {
    const d = document.createElement("span");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  /* Multi-series line chart.
     opts: {series:[{name, points:[{x, y}]}], xLabels:[], yFmt, height}
     Two x modes:
       - label mode (default): x is an index into xLabels
       - linear mode (opts.linearX): x is a numeric value (e.g. a year); gaps
         between values are honored so time reads truthfully. */
  function lineChart(container, opts) {
    if (opts.linearX) return lineChartLinear(container, opts);
    return lineChartLabels(container, opts);
  }

  // Size the drawing to the mounted container so text stays legible on
  // phones (SVG scales the viewBox; a narrower viewBox = larger glyphs).
  function fitWidth(container) {
    const w = container.getBoundingClientRect().width || 860;
    return Math.max(360, Math.min(860, Math.round(w)));
  }

  function lineChartLabels(container, opts) {
    container.innerHTML = "";
    const W = fitWidth(container), H = opts.height || 320;
    const m = { top: 14, right: 24, bottom: 26, left: 46 };
    const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
    const series = opts.series.map((s, i) => ({ ...s, color: lineColor(s.color || PALETTE[i % 8]) }));
    const nX = opts.xLabels.length;
    const allY = series.flatMap(s => s.points.map(p => p.y)).filter(v => v != null);
    if (!allY.length || nX < 1) { container.innerHTML = '<div class="empty">No data yet.</div>'; return; }
    let yMin = Math.min(...allY), yMax = Math.max(...allY);
    const pad = (yMax - yMin) * 0.08 || 1;
    yMin -= pad; yMax += pad;
    const X = i => m.left + (nX === 1 ? iw / 2 : (i / (nX - 1)) * iw);
    const Y = v => m.top + ih - ((v - yMin) / (yMax - yMin)) * ih;
    const fmt = opts.yFmt || (v => v.toFixed(1));

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, container);
    // grid + y ticks
    for (const tv of niceTicks(yMin, yMax, 5)) {
      if (tv < yMin || tv > yMax) continue;
      el("line", { x1: m.left, x2: W - m.right, y1: Y(tv), y2: Y(tv), stroke: CH().grid, "stroke-width": 1 }, svg);
      const t = el("text", { x: m.left - 8, y: Y(tv) + 4, "text-anchor": "end", fill: CH().label, "font-size": 11 }, svg);
      t.textContent = fmt(tv);
    }
    el("line", { x1: m.left, x2: W - m.right, y1: m.top + ih, y2: m.top + ih, stroke: CH().base, "stroke-width": 1 }, svg);
    // x labels (thin out)
    const every = Math.ceil(nX / Math.floor(iw / 70));
    opts.xLabels.forEach((lb, i) => {
      if (i % every !== 0 && i !== nX - 1) return;
      const t = el("text", { x: X(i), y: H - 8, "text-anchor": "middle", fill: CH().label, "font-size": 11 }, svg);
      t.textContent = lb;
    });

    for (const s of series) {
      const pts = s.points.filter(p => p.y != null);
      if (!pts.length) continue;
      const d = pts.map((p, j) => (j ? "L" : "M") + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1)).join(" ");
      el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      const last = pts[pts.length - 1];
      el("circle", { cx: X(last.x), cy: Y(last.y), r: 4, fill: s.color, stroke: CH().halo, "stroke-width": 2 }, svg);
    }
    // selective direct labels: first series endpoint value
    if (series.length <= 4) {
      series.forEach(s => {
        const pts = s.points.filter(p => p.y != null);
        if (!pts.length) return;
        const last = pts[pts.length - 1];
        const t = el("text", { x: Math.min(X(last.x) + 8, W - 2), y: Y(last.y) + 4, fill: CH().ink, "font-size": 11 }, svg);
        t.textContent = fmt(last.y);
      });
    }

    // crosshair + tooltip
    const cross = el("line", { y1: m.top, y2: m.top + ih, stroke: CH().cross, "stroke-width": 1, opacity: 0 }, svg);
    const hover = el("rect", { x: m.left, y: m.top, width: iw, height: ih, fill: "transparent" }, svg);
    function toIdx(evt) {
      const r = svg.getBoundingClientRect();
      const px = (evt.clientX - r.left) / r.width * W;
      return Math.max(0, Math.min(nX - 1, Math.round((px - m.left) / (iw || 1) * (nX - 1))));
    }
    function moveTo(evt) {
      const i = toIdx(evt);
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i));
      cross.setAttribute("opacity", 1);
      const rows = series.map(s => {
        const p = s.points.find(q => q.x === i);
        return p && p.y != null
          ? `<div class="tt-row"><span class="tt-key" style="background:${s.color}"></span><span class="tt-val">${esc(fmt(p.y))}</span> <span class="tt-name">${esc(s.name)}</span></div>`
          : "";
      }).join("");
      showTip(`<div class="tt-title">${esc(opts.xLabels[i])}</div>${rows}`, evt.clientX, evt.clientY, isTouch(evt));
    }
    bindScrub(hover, cross, moveTo);

    if (series.length >= 2) {
      const lg = document.createElement("div");
      lg.className = "legend";
      series.forEach(s => {
        const k = document.createElement("span");
        k.className = "key";
        const sw = document.createElement("span");
        sw.className = "swatch-line";
        sw.style.background = s.color;
        k.appendChild(sw);
        k.appendChild(document.createTextNode(s.name));
        lg.appendChild(k);
      });
      container.appendChild(lg);
    }
  }

  /* Linear-x variant: x values are real numbers (years). */
  function lineChartLinear(container, opts) {
    container.innerHTML = "";
    const W = fitWidth(container), H = opts.height || 320;
    const m = { top: 14, right: 30, bottom: 26, left: 46 };
    const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
    const series = opts.series.map((s, i) => ({ ...s, color: lineColor(s.color || PALETTE[i % 8]) }));
    const allPts = series.flatMap(s => s.points.filter(p => p.y != null));
    if (!allPts.length) { container.innerHTML = '<div class="empty">No data yet.</div>'; return; }
    let xMin = Math.min(...allPts.map(p => p.x)), xMax = Math.max(...allPts.map(p => p.x));
    if (xMin === xMax) { xMin -= 1; xMax += 1; }
    let yMin = Math.min(...allPts.map(p => p.y)), yMax = Math.max(...allPts.map(p => p.y));
    const pad = (yMax - yMin) * 0.08 || 1;
    yMin -= pad; yMax += pad;
    const X = v => m.left + (v - xMin) / (xMax - xMin) * iw;
    const Y = v => m.top + ih - (v - yMin) / (yMax - yMin) * ih;
    const yFmt = opts.yFmt || (v => v.toFixed(1));
    const xFmt = opts.xFmt || (v => String(Math.round(v)));

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, container);
    for (const tv of niceTicks(yMin, yMax, 5)) {
      if (tv < yMin || tv > yMax) continue;
      el("line", { x1: m.left, x2: W - m.right, y1: Y(tv), y2: Y(tv), stroke: CH().grid, "stroke-width": 1 }, svg);
      const t = el("text", { x: m.left - 8, y: Y(tv) + 4, "text-anchor": "end", fill: CH().label, "font-size": 11 }, svg);
      t.textContent = yFmt(tv);
    }
    el("line", { x1: m.left, x2: W - m.right, y1: m.top + ih, y2: m.top + ih, stroke: CH().base, "stroke-width": 1 }, svg);
    for (const tx of niceTicks(xMin, xMax, Math.min(10, Math.floor(iw / 80)))) {
      if (tx < xMin || tx > xMax) continue;
      const t = el("text", { x: X(tx), y: H - 8, "text-anchor": "middle", fill: CH().label, "font-size": 11 }, svg);
      t.textContent = xFmt(tx);
    }
    const numbered = series.length >= 2 && !opts.noLegend;
    const badges = [];
    const seriesEls = []; // per-series svg nodes so the legend can spotlight one line
    series.forEach((s, si) => {
      const pts = s.points.filter(p => p.y != null).sort((a, b) => a.x - b.x);
      if (!pts.length) return;
      const d = pts.map((p, j) => (j ? "L" : "M") + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1)).join(" ");
      const attrs = { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" };
      if (s.dash) attrs["stroke-dasharray"] = s.dash;
      const path = el("path", attrs, svg);
      const last = pts[pts.length - 1];
      const dot = el("circle", { cx: X(last.x), cy: Y(last.y), r: 4, fill: s.color, stroke: CH().halo, "stroke-width": 2 }, svg);
      seriesEls[si] = { path, dot, badge: [] };
      if (numbered) badges.push({ x: X(last.x), y: Y(last.y), color: s.color, num: si + 1, si });
    });
    // numbered chips beside each line's endpoint (de-overlapped vertically)
    if (badges.length) {
      badges.sort((a, b) => a.y - b.y);
      for (let i = 1; i < badges.length; i++) {
        if (badges[i].y - badges[i - 1].y < 16) badges[i].y = badges[i - 1].y + 16;
      }
      for (const b of badges) {
        const by = Math.min(Math.max(b.y, m.top + 7), m.top + ih + 4);
        const c = el("circle", { cx: b.x + 12, cy: by, r: 7.5, fill: b.color, stroke: CH().halo, "stroke-width": 1.5 }, svg);
        const t = el("text", { x: b.x + 12, y: by + 3.2, "text-anchor": "middle", fill: "#fff",
                               "font-size": 9.5, "font-weight": 700 }, svg);
        t.textContent = b.num;
        if (seriesEls[b.si]) seriesEls[b.si].badge = [c, t];
      }
    }
    // hover: snap to nearest x present in any series
    const xsSet = [...new Set(allPts.map(p => p.x))].sort((a, b) => a - b);
    const cross = el("line", { y1: m.top, y2: m.top + ih, stroke: CH().cross, "stroke-width": 1, opacity: 0 }, svg);
    const hover = el("rect", { x: m.left, y: m.top, width: iw, height: ih, fill: "transparent" }, svg);
    function moveTo(evt) {
      const r = svg.getBoundingClientRect();
      const vx = xMin + ((evt.clientX - r.left) / r.width * W - m.left) / iw * (xMax - xMin);
      let best = xsSet[0];
      for (const c of xsSet) if (Math.abs(c - vx) < Math.abs(best - vx)) best = c;
      cross.setAttribute("x1", X(best)); cross.setAttribute("x2", X(best));
      cross.setAttribute("opacity", 1);
      const rows = series.map((s, si) => {
        const p = s.points.find(q => q.x === best && q.y != null);
        return p ? `<div class="tt-row"><span class="tt-key" style="background:${s.color}"></span><span class="tt-val">${esc(yFmt(p.y))}</span> <span class="tt-name">${esc((numbered ? (si + 1) + " · " : "") + s.name)}</span></div>` : "";
      }).join("");
      showTip(`<div class="tt-title">${esc(xFmt(best))}</div>${rows}`, evt.clientX, evt.clientY, isTouch(evt));
    }
    bindScrub(hover, cross, moveTo);

    if (series.length >= 2 && !opts.noLegend) {
      const lg = document.createElement("div");
      lg.className = "legend";
      // tap a name to spotlight that corps' line (tap again to clear) — with a
      // dozen lines on the chart, this is how you actually FIND yours
      let focused = -1;
      const applyFocus = () => {
        series.forEach((s, si) => {
          const e = seriesEls[si];
          if (!e) return;
          const dim = focused >= 0 && si !== focused;
          e.path.setAttribute("opacity", dim ? 0.13 : 1);
          e.path.setAttribute("stroke-width", si === focused ? 3.5 : 2);
          e.dot.setAttribute("opacity", dim ? 0.13 : 1);
          e.badge.forEach(n => n.setAttribute("opacity", dim ? 0.2 : 1));
        });
        // the spotlit line rises above the pack (but stays under the crosshair)
        const f = focused >= 0 && seriesEls[focused];
        if (f) [f.path, f.dot].concat(f.badge).forEach(n => svg.insertBefore(n, cross));
        lg.querySelectorAll(".key").forEach((k, si) => k.classList.toggle("focus", si === focused));
      };
      series.forEach((s, si) => {
        const k = document.createElement("span");
        k.className = "key";
        k.title = `Highlight ${s.name}'s line`;
        k.onclick = () => { focused = focused === si ? -1 : si; applyFocus(); };
        const nb = document.createElement("span");
        nb.className = "legend-num";
        nb.style.background = s.color;
        nb.textContent = si + 1;
        k.appendChild(nb);
        const sw = document.createElement("span");
        sw.className = "swatch-line";
        if (s.dash) {
          sw.style.background = `repeating-linear-gradient(90deg, ${s.color} 0 4px, transparent 4px 7px)`;
        } else {
          sw.style.background = s.color;
        }
        k.appendChild(sw);
        k.appendChild(document.createTextNode(s.name));
        lg.appendChild(k);
      });
      container.appendChild(lg);
    }
  }

  /* Grouped bar chart with value labels on every bar (drafting-sheet style).
     opts: {groups: [{label, bars: [{name, value, color}]}], height, yFmt, yMax} */
  function barChart(container, opts) {
    container.innerHTML = "";
    const W = fitWidth(container), H = opts.height || 300;
    const m = { top: 22, right: 10, bottom: (opts.groups || []).some(g => g.sub) ? 38 : 30, left: 40 };
    const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
    const groups = (opts.groups || []).filter(g => g.bars.some(b => b.value != null));
    if (!groups.length) { container.innerHTML = '<div class="empty">No data yet.</div>'; return; }
    const allV = groups.flatMap(g => g.bars.map(b => b.value)).filter(v => v != null);
    const yMax = opts.yMax ? opts.yMax : Math.max(...allV) * 1.12;
    const Y = v => m.top + ih - (v / yMax) * ih;
    const fmt = opts.yFmt || (v => v.toFixed(1));

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, container);
    for (const tv of niceTicks(0, yMax, 4)) {
      if (tv > yMax) continue;
      el("line", { x1: m.left, x2: W - m.right, y1: Y(tv), y2: Y(tv), stroke: CH().grid, "stroke-width": 1 }, svg);
      const t = el("text", { x: m.left - 7, y: Y(tv) + 4, "text-anchor": "end", fill: CH().label, "font-size": 11 }, svg);
      t.textContent = String(+tv.toFixed(2));
    }
    el("line", { x1: m.left, x2: W - m.right, y1: m.top + ih, y2: m.top + ih, stroke: CH().base, "stroke-width": 1 }, svg);

    const gw = iw / groups.length;
    const nBars = Math.max(...groups.map(g => g.bars.length));
    const bw = Math.min(30, (gw - 14) / nBars);
    groups.forEach((g, gi) => {
      const gx = m.left + gi * gw + (gw - bw * g.bars.length - 3 * (g.bars.length - 1)) / 2;
      g.bars.forEach((b, bi) => {
        if (b.value == null) return;
        const x = gx + bi * (bw + 3);
        if (opts.track) {
          el("rect", { x: x.toFixed(1), y: m.top.toFixed(1), width: bw.toFixed(1),
                       height: ih.toFixed(1), rx: 2, fill: "#191510", opacity: 0.07 }, svg);
        }
        const y = Y(b.value);
        el("rect", { x: x.toFixed(1), y: y.toFixed(1), width: bw.toFixed(1),
                     height: (m.top + ih - y).toFixed(1), rx: 2,
                     fill: b.color || PALETTE[bi % 8] }, svg);
        if (bw >= 18) { // labels collide on very thin paired bars
          const t = el("text", { x: (x + bw / 2).toFixed(1), y: (y - 4).toFixed(1),
                                 "text-anchor": "middle", fill: CH().ink,
                                 "font-size": 9.5, "font-weight": 650 }, svg);
          t.textContent = fmt(b.value);
        }
      });
      const lb = el("text", { x: (m.left + gi * gw + gw / 2).toFixed(1), y: H - (g.sub ? 16 : 9),
                              "text-anchor": "middle", fill: CH().label, "font-size": 10.5 }, svg);
      lb.textContent = g.label;
      if (g.sub) {
        const sb = el("text", { x: (m.left + gi * gw + gw / 2).toFixed(1), y: H - 4,
                                "text-anchor": "middle", fill: CH().ink,
                                "font-size": 9.5, "font-weight": 700 }, svg);
        sb.textContent = g.sub;
      }
    });

    // legend from the first group's bar names
    const names = groups[0].bars.map(b => b.name).filter(Boolean);
    if (names.length >= 2) {
      const lg = document.createElement("div");
      lg.className = "legend";
      groups[0].bars.forEach((b, bi) => {
        const k = document.createElement("span");
        k.className = "key";
        const sw = document.createElement("span");
        sw.className = "swatch-line";
        sw.style.height = "9px";
        sw.style.background = b.color || PALETTE[bi % 8];
        k.appendChild(sw);
        k.appendChild(document.createTextNode(b.name));
        lg.appendChild(k);
      });
      container.appendChild(lg);
    }
  }

  /* tiny sparkline into an inline svg */
  function sparkline(container, values, color) {
    container.innerHTML = "";
    const W = 92, H = 26, p = 3;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "spark" }, container);
    const vs = values.filter(v => v != null);
    if (vs.length < 2) return;
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi - lo < 0.5) { const mid = (hi + lo) / 2; lo = mid - 0.5; hi = mid + 0.5; }
    const X = i => p + i / (values.length - 1) * (W - 2 * p);
    const Y = v => H - p - (v - lo) / (hi - lo) * (H - 2 * p);
    const d = values.map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1)).join(" ");
    el("path", { d, fill: "none", stroke: color || "#52514e", "stroke-width": 1.5, "stroke-linecap": "round" }, svg);
    const last = values.length - 1;
    el("circle", { cx: X(last), cy: Y(values[last]), r: 2.5, fill: color || "#c3c2b7" }, svg);
  }

  window.CCViz = { lineChart, barChart, sparkline, PALETTE, esc, showTip, hideTip };
})();
