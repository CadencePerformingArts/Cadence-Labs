/* Cadence — shareable image cards ("Wrapped" style).
   Renders a corps' season (or a show day) to a canvas and shares it as a PNG via
   the native share sheet (falls back to a download). Namespaced window.CadWrapped;
   reuses the app's corps colors. No backend — reads the static season JSON. */
(function () {
  "use strict";
  var SITE_URL = "https://lukebesel.github.io/DCI-Tracker";
  var SITE_LABEL = "lukebesel.github.io/DCI-Tracker";

  // ---- color helpers ---------------------------------------------------------
  function hx(s) { s = String(s || "").replace("#", ""); if (s.length === 3) s = s.split("").map(function (c) { return c + c; }).join(""); var n = parseInt(s, 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgb(a) { return "rgb(" + a.map(function (c) { return Math.max(0, Math.min(255, Math.round(c))); }).join(",") + ")"; }
  function shade(hex, amt) { var c = hx(hex); return rgb(c.map(function (v) { return amt < 0 ? v * (1 + amt) : v + (255 - v) * amt; })); }
  function hexA(hex, al) { var c = hx(hex); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + al + ")"; }
  function ordinal(n) { if (n == null) return "—"; var s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function pair(corps) {
    try { if (window.CadCorps && window.CadCorps.vars) { var v = window.CadCorps.vars(corps); if (v && v.bar) return { bar: v.bar, accent: v.accent }; } } catch (e) {}
    return { bar: "#0a3f6b", accent: "#f0b429" };
  }
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  // ---- data ------------------------------------------------------------------
  var SEASON_CACHE = {};
  function loadSeason(year) {
    if (!SEASON_CACHE[year]) {
      SEASON_CACHE[year] = fetch("data/seasons/" + year + ".json", { cache: "no-cache" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }
    return SEASON_CACHE[year];
  }

  // the class a corps most recently competed in that season
  function corpsClassIn(evs, corps) {
    var cls = null, date = "";
    (evs || []).forEach(function (ev) {
      (ev.classes || []).forEach(function (c) {
        (c.results || []).forEach(function (r) {
          if (r.corps === corps && (ev.date || "") >= date) { date = ev.date || ""; cls = c["class"]; }
        });
      });
    });
    return cls;
  }

  // current standing across all corps in that class — ranked by each corps'
  // most-recent score, the same way the scoreboard does it
  function computeStanding(evs, corps) {
    var cls = corpsClassIn(evs, corps);
    if (!cls) return null;
    var latest = {};
    (evs || []).forEach(function (ev) {
      (ev.classes || []).forEach(function (c) {
        if (c["class"] !== cls) return;
        (c.results || []).forEach(function (r) {
          if (r.score == null) return;
          var cur = latest[r.corps];
          if (!cur || (ev.date || "") >= cur.date) latest[r.corps] = { date: ev.date || "", score: r.score };
        });
      });
    });
    var arr = Object.keys(latest).map(function (n) { return { corps: n, score: latest[n].score }; })
      .sort(function (a, b) { return b.score - a.score; });
    var i = arr.findIndex(function (x) { return x.corps === corps; });
    if (i < 0) return null;
    return { rank: i + 1, total: arr.length, cls: cls };
  }

  function standing(corps, year) {
    return loadSeason(year).then(function (evs) { return evs ? computeStanding(evs, corps) : null; });
  }

  function seasonStats(corps, year) {
    return loadSeason(year).then(function (evs) {
      if (!evs) return null;
      var rows = [];
      evs.forEach(function (ev) {
        (ev.classes || []).forEach(function (c) {
          (c.results || []).forEach(function (r) {
            if (r.corps === corps && r.score != null) rows.push({ date: ev.date, event: ev.name, loc: ev.location, score: r.score, place: r.place });
          });
        });
      });
      rows.sort(function (a, b) { return (a.date || "").localeCompare(b.date || ""); });
      if (!rows.length) return null;
      var scores = rows.map(function (r) { return r.score; });
      var st = computeStanding(evs, corps);
      return {
        corps: corps, year: year, rows: rows, scores: scores,
        high: Math.max.apply(null, scores),
        avg: scores.reduce(function (a, b) { return a + b; }, 0) / scores.length,
        first: scores[0], last: scores[scores.length - 1],
        gained: +(scores[scores.length - 1] - scores[0]).toFixed(3),
        shows: rows.length,
        wins: rows.filter(function (r) { return r.place === 1; }).length,
        rank: st ? st.rank : null, total: st ? st.total : null, cls: st ? st.cls : null
      };
    }).catch(function () { return null; });
  }

  // ---- canvas card -----------------------------------------------------------
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function fitText(g, text, max, start, min) {
    var size = start;
    while (size > min) { g.font = "900 " + size + "px " + FONT; if (g.measureText(text).width <= max) break; size -= 4; }
    return size;
  }
  function logo(g, x, y, s, bar, accent) {
    roundRect(g, x, y, s, s, s * 0.24); g.save(); g.clip();
    g.fillStyle = "#fff"; g.fillRect(x, y, s, s);
    g.fillStyle = bar; g.beginPath(); g.moveTo(x, y); g.lineTo(x + s, y); g.lineTo(x, y + s); g.closePath(); g.fill();
    g.fillStyle = accent; g.beginPath(); g.moveTo(x + s, y); g.lineTo(x + s, y + s); g.lineTo(x, y + s); g.closePath(); g.fill();
    g.restore();
  }

  function drawSeasonCard(s) {
    var W = 1080, H = 1350, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    var g = cv.getContext("2d");
    var p = pair(s.corps), bar = p.bar, accent = p.accent, PAD = 84;
    // background
    var grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, shade(bar, 0.06)); grad.addColorStop(1, shade(bar, -0.45));
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    var rg = g.createRadialGradient(W * 0.82, H * 0.1, 0, W * 0.82, H * 0.1, W * 0.85);
    rg.addColorStop(0, hexA(accent, 0.3)); rg.addColorStop(1, hexA(accent, 0)); g.fillStyle = rg; g.fillRect(0, 0, W, H);

    // header
    g.textBaseline = "alphabetic";
    g.fillStyle = accent; g.font = "800 30px " + FONT;
    g.save(); g.translate(PAD, 120); g.fillText("C A D E N C E", 0, 0); g.restore();
    g.fillStyle = "rgba(255,255,255,.62)"; g.font = "700 30px " + FONT; g.textAlign = "right";
    g.fillText(s.year + " SEASON", W - PAD, 120); g.textAlign = "left";

    // logo + name
    logo(g, PAD, 175, 150, bar, accent);
    var nameSize = fitText(g, s.corps, W - PAD * 2, 96, 52);
    g.fillStyle = "#fff"; g.font = "900 " + nameSize + "px " + FONT;
    // wrap name if very long
    var name = s.corps, y = 175 + 150 + 96;
    if (g.measureText(name).width > W - PAD * 2) {
      var words = name.split(" "), line = "", lines = [];
      words.forEach(function (w) { var t = line ? line + " " + w : w; if (g.measureText(t).width > W - PAD * 2 && line) { lines.push(line); line = w; } else line = t; });
      if (line) lines.push(line);
      y = 175 + 150 + 78;
      lines.slice(0, 2).forEach(function (ln, i) { g.fillText(ln, PAD, y + i * (nameSize + 6)); });
      y = y + lines.slice(0, 2).length * (nameSize + 6) + 8;
    } else { g.fillText(name, PAD, y); y += 24; }
    g.fillStyle = accent; g.font = "800 34px " + FONT;
    g.fillText("Season, by the numbers", PAD, y + 20);

    // stat tiles (2x2)
    var tiles = [
      ["Season high", s.high.toFixed(3)],
      s.rank ? ["Class rank", ordinal(s.rank)] : ["Season avg", s.avg.toFixed(3)],
      ["Points gained", (s.gained >= 0 ? "+" : "") + s.gained.toFixed(2)],
      ["Shows", String(s.shows)]
    ];
    var tW = (W - PAD * 2 - 28) / 2, tH = 210, tx0 = PAD, ty0 = y + 64;
    tiles.forEach(function (t, i) {
      var tx = tx0 + (i % 2) * (tW + 28), ty = ty0 + Math.floor(i / 2) * (tH + 26);
      roundRect(g, tx, ty, tW, tH, 28); g.fillStyle = "rgba(255,255,255,.09)"; g.fill();
      roundRect(g, tx, ty, tW, tH, 28); g.lineWidth = 2; g.strokeStyle = "rgba(255,255,255,.14)"; g.stroke();
      g.fillStyle = accent; g.fillRect(tx + 30, ty + 34, 46, 6);
      g.fillStyle = "#fff"; g.font = "900 78px " + FONT; g.textBaseline = "alphabetic";
      g.fillText(t[1], tx + 30, ty + 138);
      g.fillStyle = "rgba(255,255,255,.72)"; g.font = "800 27px " + FONT;
      g.fillText(t[0].toUpperCase(), tx + 30, ty + 178);
    });

    // sparkline
    var sx = PAD, sy = ty0 + 2 * tH + 26 + 56, sw = W - PAD * 2, sh = 210;
    g.fillStyle = "rgba(255,255,255,.72)"; g.font = "800 27px " + FONT;
    g.fillText("PROGRESSION · " + s.first.toFixed(2) + " → " + s.last.toFixed(2), sx, sy - 20);
    var mn = Math.min.apply(null, s.scores), mx = Math.max.apply(null, s.scores), rng = (mx - mn) || 1;
    var n = s.scores.length;
    var X = function (i) { return sx + (n === 1 ? sw / 2 : (i / (n - 1)) * sw); };
    var Y = function (v) { return sy + sh - ((v - mn) / rng) * sh; };
    g.strokeStyle = "rgba(255,255,255,.16)"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(sx, sy + sh); g.lineTo(sx + sw, sy + sh); g.stroke();
    g.beginPath(); s.scores.forEach(function (v, i) { var xx = X(i), yy = Y(v); i ? g.lineTo(xx, yy) : g.moveTo(xx, yy); });
    g.strokeStyle = accent; g.lineWidth = 7; g.lineJoin = "round"; g.lineCap = "round"; g.stroke();
    var lx = X(n - 1), ly = Y(s.last); g.fillStyle = accent; g.beginPath(); g.arc(lx, ly, 13, 0, 6.29); g.fill();
    g.fillStyle = "#fff"; g.beginPath(); g.arc(lx, ly, 5, 0, 6.29); g.fill();

    // footer
    g.fillStyle = "rgba(255,255,255,.5)"; g.font = "700 26px " + FONT; g.textAlign = "center";
    g.fillText("Follow every score at " + SITE_LABEL, W / 2, H - 64); g.textAlign = "left";
    return cv;
  }

  // ---- shared card helpers ---------------------------------------------------
  var MONTHS_LONG = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  function newCanvas() { var cv = document.createElement("canvas"); cv.width = 1080; cv.height = 1350; return cv; }
  function fmt3(n) { return n == null ? "—" : (Math.round(n * 1000) / 1000).toFixed(3); }
  function signed3(n) { return (n > 0 ? "+" : "") + (Math.round(n * 1000) / 1000).toFixed(3); }
  function accentOf(corps) { try { if (window.CadCorps && window.CadCorps.accent) return window.CadCorps.accent(corps); } catch (e) {} return pair(corps).accent; }
  function weekday(iso) { try { return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(iso + "T12:00:00Z")); } catch (e) { return ""; } }
  function ellip(g, text, max) { text = String(text == null ? "" : text); if (g.measureText(text).width <= max) return text; var t = text; while (t.length > 1 && g.measureText(t + "…").width > max) t = t.slice(0, -1); return t + "…"; }
  function rankBadge(g, cx, cy, r, n, col) {
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fillStyle = col; g.fill();
    g.fillStyle = "#15130f"; g.font = "900 " + Math.round(r * 1.05) + "px " + FONT;
    g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(n), cx, cy + 1);
    g.textAlign = "left"; g.textBaseline = "alphabetic";
  }
  var METALS = ["#f4c542", "#cfd4dc", "#d79a63"];

  // ---- daily recap card ------------------------------------------------------
  // recap: the object CadRecap.forDate() returns, with .podium {cls, rows}
  function drawShowCard(recap) {
    var W = 1080, H = 1350, cv = newCanvas(), g = cv.getContext("2d");
    var pod = recap.podium || { cls: "", rows: [] }, winner = pod.rows[0];
    var p = winner ? pair(winner.corps) : { bar: "#0a3f6b", accent: "#f0b429" };
    var bar = p.bar, accent = p.accent, PAD = 84;
    var grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, shade(bar, 0.06)); grad.addColorStop(1, shade(bar, -0.5));
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    var rg = g.createRadialGradient(W * 0.85, H * 0.08, 0, W * 0.85, H * 0.08, W * 0.92);
    rg.addColorStop(0, hexA(accent, 0.28)); rg.addColorStop(1, hexA(accent, 0)); g.fillStyle = rg; g.fillRect(0, 0, W, H);

    g.textBaseline = "alphabetic";
    g.fillStyle = accent; g.font = "800 30px " + FONT; g.fillText("C A D E N C E", PAD, 118);
    g.fillStyle = "rgba(255,255,255,.6)"; g.textAlign = "right"; g.fillText("SHOW RECAP", W - PAD, 118); g.textAlign = "left";

    var parts = recap.date.split("-");
    var subDate = weekday(recap.date) + " · " + MONTHS_LONG[+parts[1] - 1] + " " + (+parts[2]) + ", " + parts[0];
    var cursor;
    if (recap.event) {
      // headline the show name (wrap up to 2 lines), date/location beneath
      var size = fitText(g, recap.event, W - PAD * 2, 62, 40);
      g.fillStyle = "#fff"; g.font = "900 " + size + "px " + FONT;
      var y = 210, name = recap.event;
      if (g.measureText(name).width > W - PAD * 2) {
        var words = name.split(" "), line = "", lines = [];
        words.forEach(function (w) { var t = line ? line + " " + w : w; if (g.measureText(t).width > W - PAD * 2 && line) { lines.push(line); line = w; } else line = t; });
        if (line) lines.push(line);
        lines.slice(0, 2).forEach(function (ln, i) { g.fillText(ln, PAD, y + i * (size + 6)); });
        y = y + Math.min(2, lines.length) * (size + 6) + 6;
      } else { g.fillText(name, PAD, y); y += 34; }
      g.fillStyle = accent; g.font = "800 28px " + FONT;
      g.fillText(subDate + (recap.location ? " · " + recap.location : ""), PAD, y);
      cursor = y + 62;
    } else {
      g.fillStyle = "#fff"; g.font = "900 66px " + FONT; g.fillText(MONTHS_LONG[+parts[1] - 1] + " " + (+parts[2]), PAD, 232);
      g.fillStyle = accent; g.font = "800 29px " + FONT;
      g.fillText(weekday(recap.date) + " · " + parts[0] + "  ·  " + recap.corpsCount + " corps", PAD, 274);
      cursor = 344;
    }
    g.fillStyle = "rgba(255,255,255,.72)"; g.font = "800 27px " + FONT;
    g.fillText("TOP OF THE SHOW" + (pod.cls ? " · " + pod.cls.toUpperCase() : ""), PAD, cursor); cursor += 20;
    pod.rows.slice(0, 3).forEach(function (r, i) {
      var big = i === 0, h = big ? 152 : 112, top = cursor;
      roundRect(g, PAD, top, W - PAD * 2, h, 20); g.fillStyle = "rgba(255,255,255,.09)"; g.fill();
      roundRect(g, PAD, top, 12, h, 6); g.fillStyle = accentOf(r.corps); g.fill();
      var br = big ? 34 : 27; rankBadge(g, PAD + 40 + br, top + h / 2, br, i + 1, METALS[i]);
      var nameX = PAD + 40 + br * 2 + 24;
      g.fillStyle = "#fff"; g.textBaseline = "middle"; g.textAlign = "right";
      g.font = (big ? "900 50px " : "800 42px ") + FONT; g.fillText(fmt3(r.score), W - PAD - 30, top + h / 2);
      g.textAlign = "left"; g.font = (big ? "900 46px " : "800 36px ") + FONT;
      g.fillText(ellip(g, r.corps, W - PAD - 30 - 180 - nameX), nameX, top + h / 2);
      g.textBaseline = "alphabetic";
      cursor += h + 14;
    });

    // highlights
    var f = recap.facts || {}, facts = [];
    (f.passed || []).slice(0, 1).forEach(function (pp) { facts.push([accentOf(pp.a), "MOVED AHEAD", pp.a + " passed " + pp.b]); });
    (f.movers || []).filter(function (m) { return m.delta > 0.001; }).slice(0, 1).forEach(function (m) { facts.push([accentOf(m.corps), "BIGGEST JUMP", m.corps + "  " + signed3(m.delta)]); });
    if (f.closest) facts.push([accent, "CLOSEST", f.closest.a + " over " + f.closest.b + " by " + fmt3(f.closest.gap)]);
    if ((f.highs || []).length && facts.length < 3) facts.push([accentOf(f.highs[0].corps), "SEASON HIGH", f.highs[0].corps + "  " + fmt3(f.highs[0].score)]);
    if (facts.length) {
      cursor += 14;
      g.fillStyle = "rgba(255,255,255,.72)"; g.font = "800 27px " + FONT; g.fillText("HIGHLIGHTS", PAD, cursor); cursor += 16;
      facts.slice(0, 3).forEach(function (ft) {
        if (cursor > H - 150) return;
        roundRect(g, PAD, cursor, W - PAD * 2, 86, 16); g.fillStyle = "rgba(255,255,255,.07)"; g.fill();
        g.fillStyle = ft[0]; g.fillRect(PAD + 22, cursor + 30, 30, 6);
        g.fillStyle = "rgba(255,255,255,.7)"; g.font = "800 19px " + FONT; g.fillText(ft[1], PAD + 68, cursor + 36);
        g.fillStyle = "#fff"; g.font = "700 31px " + FONT; g.fillText(ellip(g, ft[2], W - PAD * 2 - 90), PAD + 68, cursor + 70);
        cursor += 86 + 12;
      });
    }

    g.fillStyle = "rgba(255,255,255,.5)"; g.font = "700 26px " + FONT; g.textAlign = "center";
    g.fillText("Full scores at " + SITE_LABEL, W / 2, H - 60); g.textAlign = "left";
    return cv;
  }

  // ---- this day in DCI history card ------------------------------------------
  // entries: [{ y, e, loc, cls, c, s, k }] from onthisday.json (k=3 => champion)
  function drawHistoryCard(dayLabel, entries) {
    var W = 1080, H = 1350, cv = newCanvas(), g = cv.getContext("2d");
    var NAVY = "#0a2a4a", accent = "#f0b429", PAD = 84;
    var grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, shade(NAVY, 0.05)); grad.addColorStop(1, shade(NAVY, -0.55));
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    var rg = g.createRadialGradient(W * 0.18, H * 0.05, 0, W * 0.18, H * 0.05, W * 0.9);
    rg.addColorStop(0, hexA(accent, 0.22)); rg.addColorStop(1, hexA(accent, 0)); g.fillStyle = rg; g.fillRect(0, 0, W, H);

    g.textBaseline = "alphabetic";
    g.fillStyle = accent; g.font = "800 30px " + FONT; g.fillText("C A D E N C E", PAD, 118);
    g.fillStyle = "rgba(255,255,255,.6)"; g.textAlign = "right"; g.fillText("DCI HISTORY", W - PAD, 118); g.textAlign = "left";
    g.fillStyle = "rgba(255,255,255,.85)"; g.font = "800 34px " + FONT; g.fillText("This day in DCI history", PAD, 202);
    g.fillStyle = accent; g.font = "900 66px " + FONT; g.fillText(dayLabel, PAD, 276);

    var cursor = 344;
    g.fillStyle = "rgba(255,255,255,.72)"; g.font = "800 27px " + FONT; g.fillText("ON THIS DATE", PAD, cursor); cursor += 20;
    entries.slice(0, 5).forEach(function (en) {
      var h = 156, top = cursor, champ = en.k >= 3;
      roundRect(g, PAD, top, W - PAD * 2, h, 18);
      g.fillStyle = champ ? hexA(accent, 0.13) : "rgba(255,255,255,.06)"; g.fill();
      if (champ) { g.lineWidth = 2; g.strokeStyle = hexA(accent, 0.55); roundRect(g, PAD, top, W - PAD * 2, h, 18); g.stroke(); }
      g.fillStyle = accent; g.font = "900 42px " + FONT; g.fillText(String(en.y), PAD + 30, top + h / 2 + 14);
      var midX = PAD + 185, scoreLeft = W - PAD - 30 - 170;
      g.fillStyle = "#fff"; g.textAlign = "right"; g.font = "900 44px " + FONT; g.fillText(fmt3(en.s), W - PAD - 30, top + h / 2 + 14); g.textAlign = "left";
      g.fillStyle = "#fff"; g.font = "800 35px " + FONT; g.fillText(ellip(g, en.c, scoreLeft - midX), midX, top + 66);
      if (champ) {
        g.font = "800 19px " + FONT; var tag = "WORLD CHAMPION", tw = g.measureText(tag).width + 24;
        roundRect(g, midX, top + 86, tw, 32, 8); g.fillStyle = accent; g.fill();
        g.fillStyle = "#15130f"; g.fillText(tag, midX + 12, top + 108);
      } else {
        g.fillStyle = "rgba(255,255,255,.62)"; g.font = "600 25px " + FONT; g.fillText(ellip(g, en.e, scoreLeft - midX), midX, top + 104);
      }
      cursor += h + 12;
    });

    g.fillStyle = "rgba(255,255,255,.5)"; g.font = "700 26px " + FONT; g.textAlign = "center";
    g.fillText("Relive every season at " + SITE_LABEL, W / 2, H - 60); g.textAlign = "left";
    return cv;
  }

  // ---- season-progression card (the scoreboard chart, shareable) -------------
  // info: { year, cls, rows:[{ corps, color, rank, last, trend:[[x,y]...] }] }
  function drawStandingsCard(info) {
    var W = 1080, H = 1350, cv = newCanvas(), g = cv.getContext("2d");
    var NAVY = "#0a2a4a", accent = "#f0b429", PAD = 84;
    var grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, shade(NAVY, 0.05)); grad.addColorStop(1, shade(NAVY, -0.55));
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    var rg = g.createRadialGradient(W * 0.85, H * 0.06, 0, W * 0.85, H * 0.06, W * 0.9);
    rg.addColorStop(0, hexA(accent, 0.16)); rg.addColorStop(1, hexA(accent, 0)); g.fillStyle = rg; g.fillRect(0, 0, W, H);

    g.textBaseline = "alphabetic";
    g.fillStyle = accent; g.font = "800 30px " + FONT; g.fillText("C A D E N C E", PAD, 116);
    g.fillStyle = "rgba(255,255,255,.6)"; g.textAlign = "right"; g.fillText(info.year + " SEASON", W - PAD, 116); g.textAlign = "left";
    g.fillStyle = "#fff"; g.font = "900 52px " + FONT; g.fillText("Season Progression", PAD, 196);
    g.fillStyle = accent; g.font = "800 27px " + FONT; g.fillText((info.cls || "").toUpperCase(), PAD, 234);

    var rows = (info.rows || []).filter(function (r) { return r.trend && r.trend.length; }).slice(0, 14);
    if (!rows.length) {
      g.fillStyle = "rgba(255,255,255,.6)"; g.font = "600 30px " + FONT; g.fillText("Not enough scores yet.", PAD, 400);
      return cv;
    }
    var cx = PAD, cyTop = 288, cw = W - PAD * 2, chh = 540;
    var xs = [], ys = [];
    rows.forEach(function (r) { r.trend.forEach(function (p) { xs.push(p[0]); ys.push(p[1]); }); });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys), rY0 = (maxY - minY) || 1;
    minY -= rY0 * 0.06; maxY += rY0 * 0.06;
    var rX = (maxX - minX) || 1, rY = (maxY - minY) || 1;
    var X = function (x) { return cx + (x - minX) / rX * cw; };
    var Y = function (y) { return cyTop + chh - (y - minY) / rY * chh; };
    // gridlines + score labels
    for (var gi = 0; gi <= 4; gi++) {
      var yy = cyTop + chh * gi / 4;
      g.strokeStyle = "rgba(255,255,255,.09)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx, yy); g.lineTo(cx + cw, yy); g.stroke();
      g.fillStyle = "rgba(255,255,255,.4)"; g.font = "600 21px " + FONT; g.textAlign = "right";
      g.fillText((maxY - (maxY - minY) * gi / 4).toFixed(0), cx - 12, yy + 7); g.textAlign = "left";
    }
    // one line per corps, end dot carries the rank
    rows.forEach(function (r) {
      g.strokeStyle = r.color || accent; g.lineWidth = 5; g.lineJoin = "round"; g.lineCap = "round";
      g.beginPath(); r.trend.forEach(function (p, i) { var xx = X(p[0]), yy = Y(p[1]); i ? g.lineTo(xx, yy) : g.moveTo(xx, yy); }); g.stroke();
      var lp = r.trend[r.trend.length - 1], ex = X(lp[0]), ey = Y(lp[1]);
      g.fillStyle = r.color || accent; g.beginPath(); g.arc(ex, ey, 12, 0, 6.29); g.fill();
      g.fillStyle = "#fff"; g.font = "800 15px " + FONT; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(r.rank), ex, ey + 1); g.textAlign = "left"; g.textBaseline = "alphabetic";
    });
    // legend: 2 balanced columns (up to 7 each), row height shrinks to fit them all
    var perCol = Math.ceil(rows.length / 2);
    var lgTop = cyTop + chh + 62, colW = cw / 2;
    var rowH = Math.min(54, Math.floor((H - 130 - lgTop) / Math.max(perCol, 1)));
    rows.forEach(function (r, i) {
      var col = i < perCol ? 0 : 1, idx = i < perCol ? i : i - perCol;
      var lx = cx + col * colW, ly = lgTop + idx * rowH;
      g.fillStyle = "rgba(255,255,255,.5)"; g.font = "800 24px " + FONT; g.fillText(r.rank + ".", lx, ly);
      g.fillStyle = r.color || accent; roundRect(g, lx + 44, ly - 18, 20, 20, 5); g.fill();
      g.fillStyle = "#fff"; g.font = "700 26px " + FONT; g.fillText(ellip(g, r.corps, colW - 200), lx + 78, ly);
      g.fillStyle = accent; g.font = "800 26px " + FONT; g.textAlign = "right";
      g.fillText(fmt3(r.last), lx + colW - 34, ly); g.textAlign = "left";
    });
    g.fillStyle = "rgba(255,255,255,.5)"; g.font = "700 26px " + FONT; g.textAlign = "center";
    g.fillText("Live standings at " + SITE_LABEL, W / 2, H - 56); g.textAlign = "left";
    return cv;
  }
  function standingsCard(info) {
    var cv = drawStandingsCard(info);
    openViewer([{ canvas: cv, filename: "cadence-" + info.year + "-progression.png",
      title: info.year + " " + (info.cls || "") + " progression",
      caption: info.year + " · " + (info.cls || "") + " progression" }]);
    return true;
  }

  // ---- captions card ---------------------------------------------------------
  // Judge-caption winners for a single show, drawn as a shareable card. Reads
  // the flat per-show caption table (captions/<year>.json), works out who took
  // each caption, and flags any caption that changed hands since that class's
  // previous show ("upsets"). Cols per row:
  //   [date, event, class, corps, ge1, ge2, ge, vp, va, cg, vis, br, ma, pc, mus, pen, tot]
  var CAP = {};
  function loadCaptions(year) {
    return CAP[year] || (CAP[year] = fetch("data/captions/" + year + ".json", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }));
  }
  var CAP_IDX = { ge1: 4, ge2: 5, ge: 6, vp: 7, va: 8, cg: 9, vis: 10, br: 11, ma: 12, pc: 13, mus: 14, tot: 16 };
  var CAP_DEFS = [
    { key: "ge", label: "General Effect", main: true },
    { key: "vis", label: "Visual", main: true },
    { key: "mus", label: "Music", main: true },
    { key: "ge1", label: "GE 1" }, { key: "ge2", label: "GE 2" },
    { key: "vp", label: "Visual Prof." }, { key: "va", label: "Visual Analysis" },
    { key: "cg", label: "Color Guard" }, { key: "br", label: "Brass" },
    { key: "ma", label: "Music Analysis" }, { key: "pc", label: "Percussion" },
  ];
  function _winnerOf(set, idx) {
    var hi = -Infinity, who = null;
    set.forEach(function (r) { var v = r[idx]; if (v != null && v > hi) { hi = v; who = r[3]; } });
    return who == null ? null : { corps: who, score: hi };
  }
  function _marginOf(set, idx) {
    var vals = set.map(function (r) { return r[idx]; }).filter(function (v) { return v != null; })
      .sort(function (a, b) { return b - a; });
    return vals.length > 1 ? Math.round((vals[0] - vals[1]) * 1000) / 1000 : null;
  }
  function captionSummary(year, date, event, cls) {
    return loadCaptions(year).then(function (rows) {
      if (!rows || !rows.length) return null;
      var show = rows.filter(function (r) { return r[0] === date && r[1] === event; });
      if (!show.length) return null;
      // which class to feature: the requested one if present, else the biggest field
      var counts = {};
      show.forEach(function (r) { counts[r[2]] = (counts[r[2]] || 0) + 1; });
      var useCls = (cls && counts[cls]) ? cls
        : Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
      var here = show.filter(function (r) { return r[2] === useCls; });
      if (here.length < 2) return null; // need an actual contest
      // the same class's previous show (most recent earlier date with data)
      var prevDate = null;
      rows.forEach(function (r) { if (r[2] === useCls && r[0] < date && (!prevDate || r[0] > prevDate)) prevDate = r[0]; });
      var prev = prevDate ? rows.filter(function (r) { return r[2] === useCls && r[0] === prevDate; }) : [];
      var caps = CAP_DEFS.map(function (d) {
        var w = _winnerOf(here, CAP_IDX[d.key]);
        if (!w) return null;
        var pw = prev.length ? _winnerOf(prev, CAP_IDX[d.key]) : null;
        return { key: d.key, label: d.label, main: !!d.main, winner: w.corps, score: w.score,
          margin: _marginOf(here, CAP_IDX[d.key]), took: pw && pw.corps !== w.corps ? pw.corps : null };
      }).filter(Boolean);
      if (!caps.length) return null;
      var champ = _winnerOf(here, CAP_IDX.tot);
      var podium = here.slice().sort(function (a, b) { return (b[CAP_IDX.tot] || 0) - (a[CAP_IDX.tot] || 0); })
        .slice(0, 3).map(function (r) { return { corps: r[3], score: r[CAP_IDX.tot] }; });
      return { year: year, date: date, event: event, cls: useCls, prevDate: prevDate,
        caps: caps, champ: champ ? champ.corps : null, podium: podium, corpsN: here.length };
    });
  }

  function drawCaptionsCard(info) {
    var W = 1080, H = 1350, cv = newCanvas(), g = cv.getContext("2d");
    var PAD = 84, GOOD = "#ffd35c";
    // dress the whole card in the colours of the corps that won the show overall
    var champ = (info.podium && info.podium[0] && info.podium[0].corps) || info.champ;
    var theme = pair(champ), bar = theme.bar, accHex = theme.accent;
    // the accent doubles as text on the dark ground — lighten a dark corps colour
    // so scores stay legible
    var accent = capLum(accHex) < 0.5 ? shade(accHex, 0.5) : accHex;
    var grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, shade(bar, 0.06)); grad.addColorStop(1, shade(bar, -0.5));
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    var rg = g.createRadialGradient(W * 0.85, H * 0.05, 0, W * 0.85, H * 0.05, W * 0.95);
    rg.addColorStop(0, hexA(accHex, 0.18)); rg.addColorStop(1, hexA(accHex, 0)); g.fillStyle = rg; g.fillRect(0, 0, W, H);

    g.textBaseline = "alphabetic"; g.textAlign = "left";
    g.fillStyle = accent; g.font = "800 30px " + FONT; g.fillText("C A D E N C E", PAD, 116);
    g.fillStyle = "rgba(255,255,255,.6)"; g.textAlign = "right"; g.fillText(info.year + " SEASON", W - PAD, 116); g.textAlign = "left";
    g.fillStyle = "#fff"; g.font = "900 60px " + FONT; g.fillText("Caption Winners", PAD, 200);
    g.fillStyle = accent; g.font = "800 27px " + FONT;
    g.fillText(ellip(g, (info.event || "").toUpperCase() + "  ·  " + (info.cls || "").toUpperCase(), W - PAD * 2), PAD, 244);

    var caps = info.caps || [];
    var mains = caps.filter(function (c) { return c.main; });
    var subs = caps.filter(function (c) { return !c.main; });

    // three hero caption tiles: GE / Visual / Music
    var tTop = 288, tGap = 22, tW = (W - PAD * 2 - tGap * 2) / 3, tH = 268;
    mains.forEach(function (c, i) {
      var tx = PAD + i * (tW + tGap), col = pair(c.winner);
      roundRect(g, tx, tTop, tW, tH, 26); g.fillStyle = "rgba(255,255,255,.06)"; g.fill();
      roundRect(g, tx, tTop, tW, tH, 26); g.lineWidth = 2;
      g.strokeStyle = c.took ? hexA(GOOD, 0.85) : "rgba(255,255,255,.14)"; g.stroke();
      // caption label
      g.textAlign = "center";
      g.fillStyle = "rgba(255,255,255,.66)"; g.font = "800 23px " + FONT;
      g.fillText(c.label.toUpperCase(), tx + tW / 2, tTop + 46);
      // color chip + winner name (wrap to 2 lines)
      g.fillStyle = col.bar; roundRect(g, tx + tW / 2 - 9, tTop + 66, 18, 18, 5); g.fill();
      g.fillStyle = "#fff"; g.font = "900 30px " + FONT;
      var words = String(c.winner).split(" "), line = "", lines = [];
      words.forEach(function (w) { var t = line ? line + " " + w : w; if (g.measureText(t).width > tW - 24 && line) { lines.push(line); line = w; } else line = t; });
      if (line) lines.push(line);
      lines.slice(0, 2).forEach(function (ln, k) { g.fillText(ellip(g, ln, tW - 20), tx + tW / 2, tTop + 128 + k * 34); });
      // winning score
      g.fillStyle = accent; g.font = "900 46px " + FONT;
      g.fillText(fmt2(c.score), tx + tW / 2, tTop + 216);
      // change flag
      if (c.took) {
        g.fillStyle = GOOD; g.font = "800 18px " + FONT;
        g.fillText(ellip(g, "▲ took from " + c.took, tW - 20), tx + tW / 2, tTop + 250);
      } else if (c.margin != null) {
        g.fillStyle = "rgba(255,255,255,.5)"; g.font = "700 18px " + FONT;
        g.fillText("+" + fmt2(c.margin) + " margin", tx + tW / 2, tTop + 250);
      }
      g.textAlign = "left";
    });

    // sub-caption winners — two columns
    var sTop = tTop + tH + 74;
    g.fillStyle = "#fff"; g.font = "800 30px " + FONT; g.fillText("Sub-caption winners", PAD, sTop - 26);
    var colW = (W - PAD * 2) / 2, rowH = 78, perCol = Math.ceil(subs.length / 2);
    subs.forEach(function (c, i) {
      var col = i < perCol ? 0 : 1, idx = i < perCol ? i : i - perCol;
      var lx = PAD + col * colW, ly = sTop + idx * rowH, cc = pair(c.winner);
      g.fillStyle = "rgba(255,255,255,.55)"; g.font = "800 21px " + FONT;
      g.fillText(c.label.toUpperCase(), lx, ly);
      g.fillStyle = cc.bar; roundRect(g, lx, ly + 14, 16, 16, 4); g.fill();
      g.fillStyle = "#fff"; g.font = "800 27px " + FONT;
      g.fillText(ellip(g, c.winner, colW - 150), lx + 28, ly + 30);
      g.fillStyle = accent; g.font = "800 25px " + FONT; g.textAlign = "right";
      g.fillText(fmt2(c.score), lx + colW - 40, ly + 30); g.textAlign = "left";
      if (c.took) {
        g.fillStyle = GOOD; g.font = "700 16px " + FONT;
        g.fillText(ellip(g, "▲ from " + c.took, colW - 60), lx + 28, ly + 52);
      }
    });

    // overall top 3 — anchors the bottom and gives the caption story its context
    var pod = info.podium || [];
    if (pod.length) {
      var pTop = sTop + perCol * rowH + 46;
      g.fillStyle = "#fff"; g.font = "800 30px " + FONT; g.fillText("Overall", PAD, pTop);
      var medal = ["#f0b429", "#c9ccd1", "#cd7f32"];
      pod.forEach(function (r, i) {
        var py = pTop + 44 + i * 62, cc = pair(r.corps);
        g.fillStyle = medal[i] || "#c9ccd1"; g.font = "900 30px " + FONT; g.fillText(String(i + 1), PAD, py);
        g.fillStyle = cc.bar; roundRect(g, PAD + 42, py - 20, 18, 18, 5); g.fill();
        g.fillStyle = "#fff"; g.font = "800 30px " + FONT; g.fillText(ellip(g, r.corps, W - PAD * 2 - 240), PAD + 74, py);
        g.fillStyle = accent; g.font = "900 32px " + FONT; g.textAlign = "right"; g.fillText(fmt3(r.score), W - PAD, py); g.textAlign = "left";
      });
    }

    // footer: caption-flip note (the podium already names the overall leader)
    var flips = caps.filter(function (c) { return c.took; }).length;
    g.textAlign = "center";
    if (flips && info.prevDate) {
      g.fillStyle = GOOD; g.font = "800 26px " + FONT;
      g.fillText(ellip(g, "▲ " + flips + " caption" + (flips === 1 ? "" : "s") + " changed hands since the last show", W - PAD * 2), W / 2, H - 92);
    }
    g.fillStyle = "rgba(255,255,255,.5)"; g.font = "700 24px " + FONT;
    g.fillText(SITE_LABEL, W / 2, H - 52); g.textAlign = "left";
    return cv;
  }
  function fmt2(n) { return n == null ? "—" : (Math.round(n * 100) / 100).toFixed(2); }
  function capLum(hex) { var c = hx(hex); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255; }
  function captionsCard(info) {
    return captionSummary(info.year, info.date, info.event, info.cls).then(function (sum) {
      if (!sum) return false;
      var cv = drawCaptionsCard(sum);
      openViewer([{ canvas: cv, filename: "cadence-captions-" + sum.date + ".png",
        title: "Caption winners · " + sum.event,
        caption: sum.event + " · " + sum.cls + " caption winners" }]);
      return true;
    });
  }

  var HIST = null;
  function loadHistory() {
    // in docs/ (not docs/data/) — the scraper wipes docs/data on every run
    return HIST || (HIST = fetch("onthisday.json", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }));
  }
  function historyCard(mmdd, label) {
    return loadHistory().then(function (idx) {
      var entries = (idx && idx[mmdd]) || [];
      if (!entries.length) return null;
      return { canvas: drawHistoryCard(label, entries),
        filename: "cadence-dci-history-" + mmdd + ".png",
        title: "This day in DCI history · " + label, caption: "This day in DCI history · " + label };
    });
  }

  // ---- share -----------------------------------------------------------------
  function shareCanvas(cv, filename, title) {
    return new Promise(function (res) {
      cv.toBlob(function (blob) {
        if (!blob) return res(false);
        var file = new File([blob], filename, { type: "image/png" });
        var data = { files: [file], title: title, text: title + " — via Cadence", url: SITE_URL };
        if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
          navigator.share(data).then(function () { res(true); }, function () { res(false); });
          return;
        }
        // fallback: download the image
        var url = URL.createObjectURL(blob), a = document.createElement("a");
        a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000); res(false);
      }, "image/png");
    });
  }

  function slug(s) { return String(s).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase(); }

  // ---- in-app card viewer ----------------------------------------------------
  // A lightbox that shows one or more cards big, in the app, each with a Share
  // button. Season card, daily recaps and history all open here — one surface.
  var VIEW_CSS =
    ".cad-ov{position:fixed;inset:0;z-index:4200;display:flex;align-items:center;justify-content:center;background:rgba(6,8,14,.74);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);padding:20px;animation:cadFade .18s ease}" +
    "@keyframes cadFade{from{opacity:0}to{opacity:1}}" +
    ".cad-modal{position:relative;width:min(430px,100%);display:flex;flex-direction:column;align-items:center;gap:13px}" +
    ".cad-x{position:absolute;top:-4px;right:-4px;z-index:3;width:40px;height:40px;border-radius:999px;border:none;background:rgba(255,255,255,.15);color:#fff;font-size:25px;line-height:38px;cursor:pointer}" +
    ".cad-x:hover{background:rgba(255,255,255,.26)}" +
    ".cad-cap{color:#fff;font-weight:700;font-size:14px;opacity:.92;text-align:center;min-height:18px}" +
    ".cad-stage{position:relative;width:100%;display:flex;justify-content:center;touch-action:pan-y}" +
    ".cad-img{width:100%;max-width:380px;max-height:70vh;object-fit:contain;border-radius:18px;box-shadow:0 20px 54px rgba(0,0,0,.55);animation:cadPop .22s ease}" +
    "@keyframes cadPop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}" +
    ".cad-dots{display:flex;gap:7px;min-height:7px}" +
    ".cad-dot{width:7px;height:7px;border-radius:999px;background:rgba(255,255,255,.32);cursor:pointer;transition:background .15s,width .15s}" +
    ".cad-dot.on{background:#fff;width:18px}" +
    ".cad-actions{display:flex;align-items:center;gap:12px}" +
    ".cad-btn{font:inherit;font-weight:700;cursor:pointer;border-radius:999px}" +
    ".cad-btn.primary{display:inline-flex;align-items:center;gap:7px;padding:11px 26px;font-size:15px;border:none;background:var(--accent,#f0b429);color:var(--on-accent,#15130f)}" +
    ".cad-btn.primary:disabled{opacity:.6}" +
    ".cad-btn.ghost{width:44px;height:44px;font-size:21px;border:1px solid rgba(255,255,255,.26);background:rgba(255,255,255,.08);color:#fff}" +
    ".cad-btn.ghost:hover{background:rgba(255,255,255,.16)}" +
    ".cad-btn.ghost[hidden]{display:none}" +
    ".cad-btn.primary svg{width:16px;height:16px}";
  function ensureStyle() {
    if (document.getElementById("cad-wrapped-css")) return;
    var s = document.createElement("style"); s.id = "cad-wrapped-css"; s.textContent = VIEW_CSS;
    document.head.appendChild(s);
  }
  var SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M8 7l4-4 4 4M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/></svg>';

  // cards: [{ canvas, filename, title, caption }]
  function openViewer(cards) {
    cards = (cards || []).filter(Boolean);
    if (!cards.length) return null;
    ensureStyle();
    var idx = 0, urls = [];
    var ov = document.createElement("div"); ov.className = "cad-ov";
    ov.innerHTML =
      '<div class="cad-modal" role="dialog" aria-modal="true" aria-label="Card">' +
      '<button class="cad-x" aria-label="Close">&times;</button>' +
      '<div class="cad-stage"><img class="cad-img" alt=""></div>' +
      '<div class="cad-cap"></div>' +
      '<div class="cad-dots"></div>' +
      '<div class="cad-actions">' +
      '<button class="cad-btn ghost cad-prev" aria-label="Previous">&#8249;</button>' +
      '<button class="cad-btn primary cad-share">' + SHARE_ICON + '<span>Share</span></button>' +
      '<button class="cad-btn ghost cad-next" aria-label="Next">&#8250;</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    var img = ov.querySelector(".cad-img"), cap = ov.querySelector(".cad-cap"),
      dotsEl = ov.querySelector(".cad-dots"), prev = ov.querySelector(".cad-prev"),
      next = ov.querySelector(".cad-next"), shareBtn = ov.querySelector(".cad-share");
    var multi = cards.length > 1;
    prev.hidden = next.hidden = !multi;
    dotsEl.innerHTML = multi ? cards.map(function () { return '<span class="cad-dot"></span>'; }).join("") : "";
    function urlFor(i) { if (!urls[i]) { try { urls[i] = cards[i].canvas.toDataURL("image/png"); } catch (e) { urls[i] = ""; } } return urls[i]; }
    function show(i) {
      idx = (i + cards.length) % cards.length;
      img.src = urlFor(idx);
      cap.textContent = cards[idx].caption || cards[idx].title || "";
      if (multi) { var ds = dotsEl.children; for (var k = 0; k < ds.length; k++) ds[k].className = "cad-dot" + (k === idx ? " on" : ""); }
    }
    function close() { document.removeEventListener("keydown", onKey); ov.remove(); }
    function onKey(e) { if (e.key === "Escape") close(); else if (multi && e.key === "ArrowRight") show(idx + 1); else if (multi && e.key === "ArrowLeft") show(idx - 1); }
    ov.querySelector(".cad-x").onclick = close;
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    prev.onclick = function () { show(idx - 1); };
    next.onclick = function () { show(idx + 1); };
    for (var d = 0; d < dotsEl.children.length; d++) (function (j) { dotsEl.children[j].onclick = function () { show(j); }; })(d);
    document.addEventListener("keydown", onKey);
    // swipe between cards
    if (multi) {
      var sx = 0, sy = 0, tracking = false;
      var stage = ov.querySelector(".cad-stage");
      stage.addEventListener("touchstart", function (e) { var t = e.touches[0]; sx = t.clientX; sy = t.clientY; tracking = true; }, { passive: true });
      stage.addEventListener("touchend", function (e) {
        if (!tracking) return; tracking = false;
        var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
        if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy)) show(idx + (dx < 0 ? 1 : -1));
      }, { passive: true });
    }
    shareBtn.onclick = function () {
      var c = cards[idx], lbl = shareBtn.querySelector("span");
      var was = lbl.textContent; shareBtn.disabled = true; lbl.textContent = "Sharing…";
      try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
      shareCanvas(c.canvas, c.filename, c.title).then(function () {
        shareBtn.disabled = false; lbl.textContent = was;
      });
    };
    show(0);
    return { close: close, el: ov };
  }

  function seasonCard(corps, year) {
    return seasonStats(corps, year).then(function (s) {
      if (!s) return false;
      var cv = drawSeasonCard(s);
      openViewer([{ canvas: cv, filename: slug(corps) + "-" + year + "-cadence.png",
        title: corps + " · " + year + " season", caption: corps + " · " + year }]);
      return true;
    });
  }

  window.CadWrapped = {
    seasonCard: seasonCard, openViewer: openViewer, standing: standing,
    standingsCard: standingsCard, drawStandingsCard: drawStandingsCard,
    captionsCard: captionsCard, drawCaptionsCard: drawCaptionsCard, captionSummary: captionSummary,
    drawSeasonCard: drawSeasonCard, drawShowCard: drawShowCard,
    drawHistoryCard: drawHistoryCard, historyCard: historyCard,
    shareCanvas: shareCanvas, slug: slug,
    loadSeason: loadSeason, _stats: seasonStats, _draw: drawSeasonCard,
    _helpers: { pair: pair, hexA: hexA, shade: shade, ordinal: ordinal, roundRect: roundRect, fitText: fitText, logo: logo, FONT: FONT, SITE_URL: SITE_URL, SITE_LABEL: SITE_LABEL },
  };
})();
