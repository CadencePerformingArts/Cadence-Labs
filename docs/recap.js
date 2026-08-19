/* Cadence — Daily Recaps.
   A self-contained module that turns the season data into a "what happened
   today" recap for any show day: every show's results plus fun facts (top
   score, biggest movers, new season highs, who passed whom in the standings,
   closest finish). It auto-pops the shows you missed, the same night once
   scores are in.

   Namespaced (.rc-* / cad-rc-* localStorage / window.CadRecap) and reuses the
   app's CSS variables, so it follows the viewer's light/dark (and corps) theme.
   Reads only the static season JSON the app already ships — no backend. */
(function () {
  "use strict";

  var TZ = "America/New_York";      // scores + show days are Eastern
  var SCORES_IN_HOUR = 22;          // "same night once scores are in": ET hour after which today's show day is eligible to auto-pop (10pm)
  var RECAP_RECENT_DAYS = 10;       // only auto-pop shows from the last ~week and a half
  var DATA = "data/";

  // ---- date helpers ----------------------------------------------------------
  function etParts(d) {
    var f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
    var o = {}; f.formatToParts(d || new Date()).forEach(function (p) { o[p.type] = p.value; });
    return o;
  }
  function todayET() { var p = etParts(new Date()); return p.year + "-" + p.month + "-" + p.day; }
  function hourET() { return parseInt(etParts(new Date()).hour, 10) || 0; }
  function prettyDate(ds) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" })
        .format(new Date(ds + "T12:00:00Z"));
    } catch (e) { return ds; }
  }
  function shortDate(ds) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" })
        .format(new Date(ds + "T12:00:00Z"));
    } catch (e) { return ds; }
  }

  // ---- localStorage ----------------------------------------------------------
  function lget(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  function fmt(n) { return n == null ? "—" : (Math.round(n * 1000) / 1000).toFixed(3); }
  function signed(n) { return (n > 0 ? "+" : "") + (Math.round(n * 1000) / 1000).toFixed(3); }

  // ---- data ------------------------------------------------------------------
  var yearCache = {};
  function loadYear(year) {
    if (yearCache[year]) return yearCache[year];
    return (yearCache[year] = fetch(DATA + "seasons/" + year + ".json?cb=" + Date.now(), { headers: { "cache-control": "no-cache" } })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .catch(function () { yearCache[year] = null; return null; }));
  }

  // ---- recap computation -----------------------------------------------------
  function scoredShowDays(evs) {
    var s = {};
    (evs || []).forEach(function (e) {
      if (e.date && (e.classes || []).some(function (c) { return (c.results || []).some(function (r) { return r.score != null; }); })) s[e.date] = 1;
    });
    return Object.keys(s).sort();
  }

  // history of every corps' scores across the season, in date order
  function buildHistory(evs) {
    var hist = {};
    (evs || []).slice().sort(byDate).forEach(function (e) {
      (e.classes || []).forEach(function (c) {
        (c.results || []).forEach(function (r) {
          if (r.score == null) return;
          (hist[r.corps] = hist[r.corps] || []).push({ date: e.date, score: r.score, event: e.name, cls: c.class });
        });
      });
    });
    return hist;
  }
  function byDate(a, b) { return (a.date || "") < (b.date || "") ? -1 : (a.date || "") > (b.date || "") ? 1 : 0; }

  function recapForDate(evs, date) {
    var hist = buildHistory(evs);
    var priorRows = function (corps) { return (hist[corps] || []).filter(function (x) { return x.date < date; }); };
    var priorScore = function (corps) { var h = priorRows(corps); return h.length ? h[h.length - 1] : null; };
    var priorBest = function (corps) { var h = priorRows(corps); return h.length ? Math.max.apply(null, h.map(function (x) { return x.score; })) : null; };

    var shows = (evs || []).filter(function (e) {
      return e.date === date && (e.classes || []).some(function (c) { return (c.results || []).some(function (r) { return r.score != null; }); });
    }).map(function (e) {
      return {
        name: e.name, location: e.location, url: e.url, recap_url: e.recap_url,
        classes: (e.classes || []).map(function (c) {
          return { cls: c.class, results: (c.results || []).filter(function (r) { return r.score != null; })
            .slice().sort(function (a, b) { return (a.place || 99) - (b.place || 99) || b.score - a.score; }) };
        }).filter(function (c) { return c.results.length; })
      };
    });

    // every row that competed today
    var rows = [];
    shows.forEach(function (s) { s.classes.forEach(function (c) { c.results.forEach(function (r) { rows.push({ corps: r.corps, score: r.score, place: r.place, event: s.name, cls: c.cls }); }); }); });

    // top score of the day
    var topScore = null;
    rows.forEach(function (r) { if (!topScore || r.score > topScore.score) topScore = r; });

    // biggest movers vs their previous outing
    var movers = rows.map(function (r) {
      var p = priorScore(r.corps);
      return p ? { corps: r.corps, score: r.score, prev: p.score, delta: +(r.score - p.score).toFixed(3), event: r.event } : null;
    }).filter(Boolean).sort(function (a, b) { return b.delta - a.delta; });

    // new season highs (beat everything they'd done before, and had a before)
    var highs = rows.filter(function (r) { var pb = priorBest(r.corps); return pb != null && r.score > pb + 1e-9; })
      .map(function (r) { return { corps: r.corps, score: r.score, event: r.event }; })
      .sort(function (a, b) { return b.score - a.score; });
    // one entry per corps
    var seenHigh = {}; highs = highs.filter(function (h) { if (seenHigh[h.corps]) return false; return (seenHigh[h.corps] = 1); });

    // who passed whom: within each class, a corps that finished ahead of one it
    // trailed at their most recent previous shared show
    var passed = [], pk = {};
    shows.forEach(function (s) {
      s.classes.forEach(function (c) {
        var rs = c.results;
        for (var i = 0; i < rs.length; i++) for (var j = i + 1; j < rs.length; j++) {
          var A = rs[i].corps, B = rs[j].corps; // A finished ahead of B today
          var ha = priorRows(A), hb = priorRows(B);
          var bByDate = {}; hb.forEach(function (x) { bByDate[x.date] = Math.max(bByDate[x.date] || -1, x.score); });
          var common = ha.filter(function (x) { return bByDate[x.date] != null; });
          if (!common.length) continue;
          var last = common[common.length - 1];
          if (bByDate[last.date] > last.score + 1e-9) { // B was ahead then, A is ahead now
            var key = A + "|" + B; if (pk[key]) continue; pk[key] = 1;
            passed.push({ a: A, b: B, cls: c.cls, event: s.name, worldish: /world/i.test(c.cls || "") });
          }
        }
      });
    });
    passed.sort(function (a, b) { return (b.worldish - a.worldish); });

    // closest finish (smallest adjacent margin within a class)
    var closest = null;
    shows.forEach(function (s) { s.classes.forEach(function (c) {
      for (var i = 1; i < c.results.length; i++) {
        var g = +(c.results[i - 1].score - c.results[i].score).toFixed(3);
        if (g >= 0 && (!closest || g < closest.gap)) closest = { a: c.results[i - 1].corps, b: c.results[i].corps, gap: g, event: s.name, cls: c.cls };
      }
    }); });

    var result = {
      date: date, pretty: prettyDate(date), shows: shows,
      corpsCount: Object.keys(rows.reduce(function (o, r) { o[r.corps] = 1; return o; }, {})).length,
      facts: { topScore: topScore, movers: movers.slice(0, 3), highs: highs.slice(0, 6), passed: passed.slice(0, 4), closest: closest }
    };
    result.podium = topOfDay(result); // marquee-class top 3, for the recap card
    return result;
  }

  // every scored show (event) on a given date
  function showsForDay(evs, date) {
    return (evs || []).filter(function (e) {
      return e.date === date && (e.classes || []).some(function (c) { return (c.results || []).some(function (r) { return r.score != null; }); });
    });
  }

  // a full recap for ONE show: every class's leaderboard + facts scoped to that
  // show (biggest mover, who passed whom, closest, new highs)
  function recapForShow(evs, ev) {
    var hist = buildHistory(evs), date = ev.date;
    var priorRows = function (corps) { return (hist[corps] || []).filter(function (x) { return x.date < date; }); };
    var priorScore = function (corps) { var h = priorRows(corps); return h.length ? h[h.length - 1] : null; };
    var priorBest = function (corps) { var h = priorRows(corps); return h.length ? Math.max.apply(null, h.map(function (x) { return x.score; })) : null; };

    var classes = (ev.classes || []).map(function (c) {
      return { cls: c.class, results: (c.results || []).filter(function (r) { return r.score != null; })
        .slice().sort(function (a, b) { return (a.place || 99) - (b.place || 99) || b.score - a.score; }) };
    }).filter(function (c) { return c.results.length; });

    var rows = [];
    classes.forEach(function (c) { c.results.forEach(function (r) { rows.push({ corps: r.corps, score: r.score, place: r.place, cls: c.cls }); }); });

    var topScore = null;
    rows.forEach(function (r) { if (!topScore || r.score > topScore.score) topScore = r; });
    var movers = rows.map(function (r) {
      var p = priorScore(r.corps);
      return p ? { corps: r.corps, score: r.score, prev: p.score, delta: +(r.score - p.score).toFixed(3) } : null;
    }).filter(Boolean).sort(function (a, b) { return b.delta - a.delta; });
    var highs = rows.filter(function (r) { var pb = priorBest(r.corps); return pb != null && r.score > pb + 1e-9; })
      .map(function (r) { return { corps: r.corps, score: r.score }; }).sort(function (a, b) { return b.score - a.score; });
    var seenH = {}; highs = highs.filter(function (h) { if (seenH[h.corps]) return false; return (seenH[h.corps] = 1); });
    var passed = [], pk = {};
    classes.forEach(function (c) {
      var rs = c.results;
      for (var i = 0; i < rs.length; i++) for (var j = i + 1; j < rs.length; j++) {
        var A = rs[i].corps, B = rs[j].corps, ha = priorRows(A), hb = priorRows(B), bd = {};
        hb.forEach(function (x) { bd[x.date] = Math.max(bd[x.date] || -1, x.score); });
        var common = ha.filter(function (x) { return bd[x.date] != null; });
        if (!common.length) continue;
        var last = common[common.length - 1];
        if (bd[last.date] > last.score + 1e-9) { var key = A + "|" + B; if (pk[key]) continue; pk[key] = 1; passed.push({ a: A, b: B, cls: c.cls, worldish: /world/i.test(c.cls || "") }); }
      }
    });
    passed.sort(function (a, b) { return b.worldish - a.worldish; });
    var closest = null;
    classes.forEach(function (c) {
      for (var i = 1; i < c.results.length; i++) {
        var g = +(c.results[i - 1].score - c.results[i].score).toFixed(3);
        if (g >= 0 && (!closest || g < closest.gap)) closest = { a: c.results[i - 1].corps, b: c.results[i].corps, gap: g, cls: c.cls };
      }
    });

    var byCls = {};
    classes.forEach(function (c) { c.results.forEach(function (r) { (byCls[c.cls] = byCls[c.cls] || []).push({ corps: r.corps, score: r.score }); }); });
    var clsKeys = Object.keys(byCls).sort(function (a, b) { return classRank(a) - classRank(b) || (a < b ? -1 : 1); });
    var mcls = clsKeys[0] || "";
    return {
      date: date, pretty: prettyDate(date), event: ev.name, location: ev.location, url: ev.url,
      classes: classes, corpsCount: Object.keys(rows.reduce(function (o, r) { o[r.corps] = 1; return o; }, {})).length,
      facts: { topScore: topScore, movers: movers.slice(0, 3), highs: highs.slice(0, 6), passed: passed.slice(0, 4), closest: closest },
      podium: { cls: mcls, rows: (byCls[mcls] || []).slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 3) },
      shows: [{ name: ev.name, location: ev.location, classes: classes }] // drawShowCard compat
    };
  }

  // ---- styles ----------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById("rc-style")) return;
    var css = [
      "@keyframes rc-pop{from{opacity:0;transform:translateY(12px) scale(.97);}to{opacity:1;transform:none;}}",
      ".rc-sech{font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);margin:14px 2px 8px;}",
      ".rc-facts{display:flex;flex-direction:column;gap:8px;}",
      ".rc-fact{display:flex;gap:11px;align-items:flex-start;background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:11px 13px;}",
      ".rc-fico{font-size:20px;line-height:1.2;flex:0 0 auto;}",
      ".rc-ft{font-size:14px;line-height:1.4;color:var(--text-primary);}",
      ".rc-ft b{font-weight:800;}",
      ".rc-ft .rc-num{font-variant-numeric:tabular-nums;font-weight:800;}",
      ".rc-ft .rc-up{color:var(--good);font-weight:800;}",
      ".rc-ftk{font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);margin-bottom:2px;}",
      ".rc-show{border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:10px;}",
      ".rc-clsh{font-size:10.5px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);padding:8px 13px 2px;}",
      ".rc-row{display:flex;align-items:center;gap:10px;padding:6px 13px;font-size:13.5px;}",
      ".rc-row+.rc-row{border-top:1px solid var(--border);}",
      ".rc-pl{flex:0 0 22px;text-align:center;font-weight:800;color:var(--muted);font-variant-numeric:tabular-nums;}",
      ".rc-cn{flex:1;color:var(--text-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".rc-sc{flex:0 0 auto;font-weight:800;font-variant-numeric:tabular-nums;color:var(--text-primary);}",
      ".rc-dot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;}",
      // narrative lead + top-3 podium
      ".rc-podium{display:flex;flex-direction:column;gap:8px;margin:2px 0 2px;}",
      ".rc-pod{display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:13px;background:var(--surface-2);border:1px solid var(--border);border-left:5px solid var(--rc-accent,var(--gold));}",
      ".rc-pod.first{padding:15px 14px;box-shadow:0 3px 14px rgba(8,20,38,.1);}",
      ".rc-medal{font-size:22px;line-height:1;flex:0 0 auto;}",
      ".rc-pod.first .rc-medal{font-size:30px;}",
      ".rc-pod-main{flex:1;min-width:0;}",
      ".rc-pod-corps{font-weight:800;font-size:14.5px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".rc-pod.first .rc-pod-corps{font-size:18px;}",
      ".rc-pod-score{flex:0 0 auto;font-weight:900;font-variant-numeric:tabular-nums;font-size:18px;color:var(--text-primary);}",
      ".rc-pod.first .rc-pod-score{font-size:25px;}",
      ".rc-medcol{flex:0 0 22px;text-align:center;font-variant-numeric:tabular-nums;}",
      ".rc-sechcls{color:var(--gold);}",
      // class badge — color-codes each day (World Class = gold) and marks the tier
      // top-bar button
      // ---- rich per-show recap popup (a full in-app view) ----
      ".sr-overlay{position:fixed;inset:0;z-index:3600;display:flex;align-items:center;justify-content:center;padding:16px;}",
      ".sr-backdrop{position:absolute;inset:0;background:rgba(6,10,18,.66);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);}",
      ".sr-card{position:relative;z-index:3;width:100%;max-width:470px;max-height:94vh;display:flex;flex-direction:column;background:var(--surface-1);color:var(--text-primary);border:1px solid var(--border);border-radius:22px;box-shadow:0 26px 74px rgba(6,10,18,.6);overflow:hidden;}",
      ".sr-card.sr-in{animation:sr-pop .28s cubic-bezier(.2,.9,.3,1.15) both;}",
      "@keyframes sr-pop{from{opacity:0;transform:translateY(14px) scale(.975);}to{opacity:1;transform:none;}}",
      "@media (prefers-reduced-motion: reduce){.sr-card.sr-in{animation:none;}}",
      // hero header in the winner's corps colors
      ".sr-hero{position:relative;flex:0 0 auto;padding:16px 18px 17px;color:#fff;background:linear-gradient(158deg,var(--sr-bar1,#123a5e),var(--sr-bar2,#0a1420));}",
      ".sr-hero::after{content:'';position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 100% at 90% -20%,var(--sr-glow,rgba(240,180,41,.4)),transparent 60%);}",
      ".sr-hero>*{position:relative;}",
      ".sr-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;min-height:30px;}",
      ".sr-count{font-size:12px;font-weight:800;letter-spacing:1px;color:rgba(255,255,255,.82);background:rgba(255,255,255,.14);padding:4px 10px;border-radius:999px;}",
      ".sr-topbtns{display:flex;align-items:center;gap:8px;}",
      ".sr-closeall{font:inherit;font-size:12.5px;font-weight:700;color:#fff;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:5px 12px;cursor:pointer;}",
      ".sr-closeall:hover{background:rgba(255,255,255,.24);}",
      ".sr-x{width:34px;height:34px;border:0;border-radius:50%;background:rgba(255,255,255,.16);color:#fff;font-size:21px;line-height:1;cursor:pointer;display:grid;place-items:center;}",
      ".sr-x:hover{background:rgba(255,255,255,.28);}",
      ".sr-eyebrow{font-size:11px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:var(--sr-acc);filter:brightness(1.25) saturate(1.1);}",
      ".sr-title{font-size:24px;line-height:1.08;font-weight:900;letter-spacing:-.4px;margin:5px 0 0;color:#fff;}",
      ".sr-sub{font-size:12.5px;color:rgba(255,255,255,.8);margin-top:5px;}",
      // scroll body
      ".sr-body{padding:14px 16px 8px;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1 1 auto;}",
      // podium + facts reuse the rc-* look; leaderboard rows compact
      ".rc-sech{font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);margin:14px 2px 8px;}",
      ".rc-sechcls{color:var(--gold);}",
      ".rc-podium{display:flex;flex-direction:column;gap:8px;}",
      ".rc-pod{display:flex;align-items:center;gap:12px;padding:10px 13px;border-radius:13px;background:var(--surface-2);border:1px solid var(--border);border-left:5px solid var(--rc-accent,var(--gold));}",
      ".rc-pod.first{padding:14px 13px;}",
      ".rc-medal{font-size:21px;line-height:1;flex:0 0 auto;}",
      ".rc-pod.first .rc-medal{font-size:28px;}",
      ".rc-pod-main{flex:1;min-width:0;}",
      ".rc-pod-corps{font-weight:800;font-size:14.5px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".rc-pod.first .rc-pod-corps{font-size:17.5px;}",
      ".rc-pod-score{flex:0 0 auto;font-weight:900;font-variant-numeric:tabular-nums;font-size:18px;color:var(--text-primary);}",
      ".rc-pod.first .rc-pod-score{font-size:23px;}",
      ".rc-facts{display:flex;flex-direction:column;gap:8px;}",
      ".rc-fact{display:flex;gap:11px;align-items:flex-start;background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:10px 13px;}",
      ".rc-fico{font-size:19px;line-height:1.2;flex:0 0 auto;}",
      ".rc-ftk{font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);margin-bottom:2px;}",
      ".rc-ft{font-size:14px;line-height:1.4;color:var(--text-primary);}",
      ".rc-ft b{font-weight:800;}",
      ".rc-ft .rc-num{font-variant-numeric:tabular-nums;font-weight:800;}",
      ".rc-ft .rc-up{color:var(--good);font-weight:800;}",
      ".rc-clsh{font-size:11px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);background:var(--surface-2);padding:8px 13px;}",
      ".rc-row{display:flex;align-items:center;gap:10px;padding:7px 13px;font-size:13.5px;}",
      ".rc-row+.rc-row{border-top:1px solid var(--border);}",
      ".rc-row.rc-fav{background:var(--accent-wash);font-weight:650;}",
      ".rc-pl{flex:0 0 22px;text-align:center;font-weight:800;color:var(--muted);font-variant-numeric:tabular-nums;}",
      ".rc-medcol{flex:0 0 22px;text-align:center;}",
      ".rc-cn{flex:1;color:var(--text-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".rc-sc{flex:0 0 auto;font-weight:800;font-variant-numeric:tabular-nums;color:var(--text-primary);}",
      ".rc-dot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;}",
      // sticky action bar
      ".sr-actions{flex:0 0 auto;display:flex;gap:10px;padding:12px 16px;border-top:1px solid var(--border);background:var(--surface-1);}",
      ".sr-share{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:7px;font:inherit;font-size:14.5px;font-weight:800;cursor:pointer;border:0;border-radius:999px;padding:12px 16px;background:var(--gold);color:#16233d;}",
      ".sr-share svg{width:16px;height:16px;}",
      ".sr-share:hover{filter:brightness(1.04);}",
      ".sr-next{flex:0 0 auto;font:inherit;font-size:14.5px;font-weight:800;cursor:pointer;border:1px solid var(--border);border-radius:999px;padding:12px 20px;background:var(--surface-2);color:var(--text-primary);}",
      ".sr-next:hover{border-color:var(--muted);}",
      // caption-winners call-to-action inside the recap body
      ".sr-capcta{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;margin:2px 0 8px;border:1px solid var(--border);background:var(--surface-2);color:var(--text-primary);border-radius:13px;padding:12px 14px;font:inherit;font-size:15px;font-weight:800;cursor:pointer;}",
      ".sr-capcta svg{width:16px;height:16px;flex:none;color:var(--gold);}",
      ".sr-capcta span{font-weight:600;font-size:12.5px;color:var(--muted);}",
      ".sr-capcta:hover{border-color:var(--gold);}",
      ".sr-capcta:disabled{opacity:.6;cursor:default;}"
    ].join("\n");
    var st = document.createElement("style"); st.id = "rc-style"; st.textContent = css; document.head.appendChild(st);
  }

  // ---- marquee podium --------------------------------------------------------
  var CLASS_ORDER = ["World Class", "Open Class", "All-Age", "International"];
  function classRank(c) { var i = CLASS_ORDER.indexOf(c); return i < 0 ? 99 : i; }
  // the podium must NOT mix classes — World Class and All-Age are separate
  // competitions on different scales. Take the day's marquee class (the
  // highest-tier one present) and rank the top 3 within it.
  function topOfDay(recap) {
    var byCls = {};
    recap.shows.forEach(function (s) { s.classes.forEach(function (c) { c.results.forEach(function (r) {
      (byCls[c.cls] = byCls[c.cls] || []).push({ corps: r.corps, score: r.score, event: s.name });
    }); }); });
    var classes = Object.keys(byCls);
    if (!classes.length) return { cls: "", rows: [] };
    classes.sort(function (a, b) { return classRank(a) - classRank(b) || (a < b ? -1 : 1); });
    var cls = classes[0];
    return { cls: cls, rows: byCls[cls].slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 3) };
  }

  // corps accent from the app's shared palette; neutral gold fallback
  function accent(corps) {
    try { if (window.CadCorps && window.CadCorps.accent) return window.CadCorps.accent(corps); } catch (e) {}
    return "var(--gold)";
  }
  function corpsVars(corps) {
    try { if (window.CadCorps && window.CadCorps.vars) return window.CadCorps.vars(corps); } catch (e) {}
    return { bar: "#0a3f6b", accent: "#f0b429" };
  }
  function hx(s) { s = String(s || "").replace("#", ""); if (s.length === 3) s = s.split("").map(function (c) { return c + c; }).join(""); var n = parseInt(s, 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(a, b, t) { return a.map(function (c, i) { return Math.round(c * (1 - t) + b[i] * t); }); }
  function rgbs(a) { return "rgb(" + a.map(function (c) { return Math.max(0, Math.min(255, c)); }).join(",") + ")"; }
  function rgbaOf(hex, al) { var c = hx(hex); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + al + ")"; }

  // ---- render: rich per-show recap (a full in-app view, not an image) --------
  var MEDALS = ["🥇", "🥈", "🥉"];
  function factsHtml(f) {
    var out = [];
    (f.passed || []).slice(0, 3).forEach(function (p) {
      out.push(fact("↗", "Moved ahead", "<b>" + esc(p.a) + "</b> passed <b>" + esc(p.b) + "</b>", p.cls));
    });
    (f.movers || []).filter(function (m) { return m.delta > 0.001; }).slice(0, 2).forEach(function (m) {
      out.push(fact("📈", "Biggest jump", "<b>" + esc(m.corps) + "</b> <span class='rc-up'>" + signed(m.delta) + "</span> — " + fmt(m.prev) + " → <span class='rc-num'>" + fmt(m.score) + "</span>", ""));
    });
    if ((f.highs || []).length) out.push(fact("🔥", "New season high" + (f.highs.length > 1 ? "s" : ""),
      f.highs.slice(0, 4).map(function (h) { return "<b>" + esc(h.corps) + "</b> <span class='rc-num'>" + fmt(h.score) + "</span>"; }).join(" · "), ""));
    if (f.closest) out.push(fact("🤏", "Closest finish",
      "<b>" + esc(f.closest.a) + "</b> over <b>" + esc(f.closest.b) + "</b> by <span class='rc-num'>" + fmt(f.closest.gap) + "</span>", f.closest.cls));
    return out.length ? '<div class="rc-facts">' + out.join("") + "</div>" : "";
  }
  function fact(ico, key, txt, cls) {
    return '<div class="rc-fact"><div class="rc-fico">' + ico + '</div><div style="min-width:0"><div class="rc-ftk">' + esc(key) + (cls ? " · " + esc(cls) : "") + '</div><div class="rc-ft">' + txt + "</div></div></div>";
  }
  function podiumHtml(recap) {
    var top = recap.podium;
    if (!top || !top.rows.length) return "";
    var pods = top.rows.map(function (r, i) {
      return '<div class="rc-pod' + (i === 0 ? " first" : "") + '" style="--rc-accent:' + accent(r.corps) + '">' +
        '<div class="rc-medal">' + MEDALS[i] + "</div>" +
        '<div class="rc-pod-main"><div class="rc-pod-corps">' + esc(r.corps) + "</div></div>" +
        '<div class="rc-pod-score">' + fmt(r.score) + "</div></div>";
    }).join("");
    return '<div class="rc-sech">Top of the show' + (top.cls ? ' · <span class="rc-sechcls">' + esc(top.cls) + "</span>" : "") + "</div>" +
      '<div class="rc-podium">' + pods + "</div>";
  }
  function favSet() {
    try { return new Set(JSON.parse(localStorage.getItem("cad-favs") || "[]")); }
    catch (e) { return new Set(); }
  }
  function leaderboardHtml(recap) {
    var favs = favSet();
    return recap.classes.map(function (c) {
      var rows = c.results.map(function (r) {
        var pl = r.place >= 1 && r.place <= 3 ? '<span class="rc-medcol">' + MEDALS[r.place - 1] + "</span>" : '<span class="rc-pl">' + (r.place || "") + "</span>";
        var fav = favs.has(r.corps);
        return '<div class="rc-row' + (fav ? " rc-fav" : "") + '">' + pl +
          '<span class="rc-dot" style="background:' + accent(r.corps) + '"></span>' +
          '<span class="rc-cn">' + (fav ? "★ " : "") + esc(r.corps) + '</span><span class="rc-sc">' + fmt(r.score) + "</span></div>";
      }).join("");
      return '<div class="rc-cls"><div class="rc-clsh">' + esc(c.cls) + " · " + c.results.length + " corps</div>" + rows + "</div>";
    }).join("");
  }
  function renderShowRecap(recap, idx, total) {
    var v = corpsVars((recap.podium && recap.podium.rows[0] && recap.podium.rows[0].corps) || "");
    var multi = total > 1;
    var loc = recap.location ? esc(recap.location) + " · " : "";
    var bar = hx(v.bar);
    var heroVars = "--sr-bar1:" + rgbs(mix(bar, [255, 255, 255], .05)) +
      ";--sr-bar2:" + rgbs(mix(bar, [6, 7, 10], .55)) +
      ";--sr-glow:" + rgbaOf(v.accent, .4) + ";--sr-acc:" + v.accent;
    return '<div class="sr-hero" style="' + heroVars + '">' +
      '<div class="sr-top">' +
        (multi ? '<span class="sr-count">' + (idx + 1) + " / " + total + "</span>" : "<span></span>") +
        '<div class="sr-topbtns">' +
          (multi ? '<button class="sr-closeall" type="button">Close all</button>' : "") +
          '<button class="sr-x" type="button" aria-label="' + (multi ? "Next" : "Close") + '">×</button>' +
        "</div>" +
      "</div>" +
      '<div class="sr-eyebrow">Show recap · ' + esc(shortDate(recap.date)) + "</div>" +
      '<h2 class="sr-title">' + esc(recap.event) + "</h2>" +
      '<div class="sr-sub">' + loc + recap.corpsCount + " corps · " + recap.classes.length + " class" + (recap.classes.length === 1 ? "" : "es") + "</div>" +
      "</div>" +
      '<div class="sr-body">' +
        podiumHtml(recap) +
        (+recap.date.slice(0, 4) >= 2013
          ? '<button class="sr-capcta" type="button">' + TROPHY_SVG + ' Caption winners <span>who took GE · Visual · Music →</span></button>' : "") +
        (factsHtml(recap.facts) ? '<div class="rc-sech">Highlights</div>' + factsHtml(recap.facts) : "") +
        '<div class="rc-sech">Full results</div>' + leaderboardHtml(recap) +
      "</div>" +
      '<div class="sr-actions">' +
        '<button class="sr-share" type="button">' + SHARE_SVG + " Share image</button>" +
        (multi ? '<button class="sr-next" type="button">Next ›</button>' : "") +
      "</div>";
  }

  // swipeable stack of rich show-recap popups
  var stackList = [], stackIdx = 0, srOverlay = null;
  var SHARE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/></svg>';
  var TROPHY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 5H4v2a3 3 0 0 0 3 3"/><path d="M17 5h3v2a3 3 0 0 1-3 3"/></svg>';
  function closeStack() {
    if (srOverlay) { srOverlay.remove(); srOverlay = null; }
    document.removeEventListener("keydown", onStackKey, true);
    stackList = [];
  }
  function onStackKey(e) {
    if (!srOverlay) return;
    if (e.key === "Escape") { e.preventDefault(); advance(); }
    else if (e.key === "ArrowRight") advance();
  }
  function advance() { // dismiss current → next, or close when done
    stackIdx++;
    if (stackIdx >= stackList.length) { closeStack(); return; }
    paintStack(true);
  }
  function shareCurrent() {
    var recap = stackList[stackIdx];
    if (!window.CadWrapped || !window.CadWrapped.drawShowCard) return;
    var cv = window.CadWrapped.drawShowCard(recap);
    window.CadWrapped.openViewer([{ canvas: cv, filename: "cadence-recap-" + recap.date + ".png",
      title: "DCI recap · " + recap.event, caption: recap.event + " · " + shortDate(recap.date) }]);
  }
  function openCaptions(btn) {
    var recap = stackList[stackIdx];
    if (!window.CadWrapped || !window.CadWrapped.captionsCard) return;
    var orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = "Loading caption sheet…";
    window.CadWrapped.captionsCard({
      year: +recap.date.slice(0, 4), date: recap.date, event: recap.event,
      cls: recap.podium && recap.podium.cls,
    }).then(function (ok) {
      btn.disabled = false;
      if (ok) { btn.innerHTML = orig; return; }
      btn.innerHTML = "No caption sheet for this show yet";
      setTimeout(function () { if (btn.isConnected) btn.innerHTML = orig; }, 1900);
    }).catch(function () { btn.disabled = false; btn.innerHTML = orig; });
  }
  function paintStack(slide) {
    var card = srOverlay.querySelector(".sr-card");
    card.innerHTML = renderShowRecap(stackList[stackIdx], stackIdx, stackList.length);
    card.scrollTop = 0;
    if (slide) { card.classList.remove("sr-in"); void card.offsetWidth; card.classList.add("sr-in"); }
    card.querySelector(".sr-x").addEventListener("click", advance);
    var ca = card.querySelector(".sr-closeall"); if (ca) ca.addEventListener("click", closeStack);
    var nx = card.querySelector(".sr-next"); if (nx) nx.addEventListener("click", advance);
    card.querySelector(".sr-share").addEventListener("click", shareCurrent);
    var cap = card.querySelector(".sr-capcta"); if (cap) cap.addEventListener("click", function () { openCaptions(cap); });
    wireSwipe(card);
  }
  function wireSwipe(card) {
    var sx = 0, sy = 0, drag = false, decided = false, horiz = false;
    var body = card.querySelector(".sr-body");
    card.addEventListener("touchstart", function (e) {
      var t = e.touches[0]; sx = t.clientX; sy = t.clientY; drag = true; decided = false; horiz = false;
    }, { passive: true });
    card.addEventListener("touchmove", function (e) {
      if (!drag) return;
      var t = e.touches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (!decided) { decided = Math.abs(dx) > 8 || Math.abs(dy) > 8; horiz = Math.abs(dx) > Math.abs(dy) + 4; }
      if (decided && horiz) { card.style.transform = "translateX(" + dx + "px) rotate(" + (dx / 40) + "deg)"; card.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 420)); }
    }, { passive: true });
    card.addEventListener("touchend", function (e) {
      if (!drag) return; drag = false;
      var dx = e.changedTouches[0].clientX - sx;
      if (horiz && Math.abs(dx) > 90) {
        card.style.transition = "transform .22s ease, opacity .22s ease";
        card.style.transform = "translateX(" + (dx < 0 ? -600 : 600) + "px) rotate(" + (dx < 0 ? -12 : 12) + "deg)"; card.style.opacity = "0";
        setTimeout(function () { card.style.transition = ""; card.style.transform = ""; card.style.opacity = ""; advance(); }, 200);
      } else { card.style.transition = "transform .2s ease, opacity .2s ease"; card.style.transform = ""; card.style.opacity = ""; setTimeout(function () { card.style.transition = ""; }, 200); }
    }, { passive: true });
  }
  function openStack(recaps) {
    recaps = (recaps || []).filter(Boolean);
    if (!recaps.length) return;
    injectStyles();
    if (srOverlay) closeStack();
    stackList = recaps; stackIdx = 0;
    srOverlay = document.createElement("div");
    srOverlay.className = "sr-overlay";
    srOverlay.setAttribute("role", "dialog"); srOverlay.setAttribute("aria-modal", "true"); srOverlay.setAttribute("aria-label", "Show recap");
    srOverlay.innerHTML = '<div class="sr-backdrop"></div><div class="sr-card sr-in"></div>';
    srOverlay.querySelector(".sr-backdrop").addEventListener("click", closeStack);
    document.body.appendChild(srOverlay);
    document.addEventListener("keydown", onStackKey, true);
    paintStack(false);
  }

  // ---- auto-show -------------------------------------------------------------
  // The latest show day worth popping: newest scored day this season, but if
  // that day is TODAY it only counts once it's late enough that scores are in.
  function latestEligibleDay(evs) {
    var days = scoredShowDays(evs);
    if (!days.length) return null;
    var last = days[days.length - 1], today = todayET();
    if (last > today) return null;               // future-dated (shouldn't happen)
    if (last === today && hourET() < SCORES_IN_HOUR) return null; // tonight, but scores may still be landing
    return last;
  }
  function eligible(d) {
    var today = todayET();
    if (d > today) return false;
    if (d === today && hourET() < SCORES_IN_HOUR) return false;
    // a recap is a "what you missed this week" moment, not an archive: never
    // auto-pop a show from months ago (e.g. a first visit in the off-season)
    return d >= new Date(Date.now() - RECAP_RECENT_DAYS * 864e5).toISOString().slice(0, 10);
  }
  // the individual SHOWS you missed: newest-first, eligible, unseen. Tracked
  // per show (date + event) so each show you haven't caught up on appears once.
  function seenKey(ev) { return "cad-rc-show-" + ev.date + "|" + (ev.name || ""); }
  function missedShows(evs, cap) {
    cap = cap || 3;
    var days = scoredShowDays(evs), out = [];
    for (var i = days.length - 1; i >= 0 && out.length < cap; i--) {
      var d = days[i];
      if (!eligible(d)) continue;
      var shows = showsForDay(evs, d);
      var unseen = shows.filter(function (ev) { return !lget(seenKey(ev)); });
      if (!unseen.length) break;                    // caught up through here
      unseen.forEach(function (ev) { if (out.length < cap) out.push(ev); });
    }
    return out; // newest first
  }
  function maybeAutoShow() {
    // at most one stack per session…
    try { if (sessionStorage.getItem("cad-rc-session")) return; } catch (e) {}
    // …and each show recaps exactly once, ever (seenKey below). Together those
    // mean: you get caught up on shows you haven't seen, and never see the same
    // recap twice. ("cad-rc-autoseen" used to cap this at one popup for the
    // life of the install because the season calendar was the permanent home
    // for recaps; with the calendar gone that flag would retire the feature
    // after a single use, so it is no longer consulted.)
    var year = +todayET().slice(0, 4);
    loadYear(year).then(function (evs) {
      if (!evs) return;
      var shows = missedShows(evs, 3);              // at most 3, so it's not a wall of popups
      if (!shows.length) return;                    // nothing new to catch up on
      try { sessionStorage.setItem("cad-rc-session", "1"); } catch (e) {}
      shows.forEach(function (ev) { lset(seenKey(ev), "1"); });
      openStack(shows.map(function (ev) { return recapForShow(evs, ev); }));
    });
  }

  function init() {
    setTimeout(function () { try { maybeAutoShow(); } catch (e) {} }, 0);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.CadRecap = {
    show: function (year, date) {
      loadYear(year || +todayET().slice(0, 4)).then(function (evs) {
        if (!evs) return;
        var d = date || latestEligibleDay(evs);
        if (d) openStack(showsForDay(evs, d).map(function (ev) { return recapForShow(evs, ev); }));
      });
    },
    forShow: recapForShow, forDate: recapForDate, close: closeStack
  };
})();
