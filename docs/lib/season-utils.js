/* Cadence season utilities — pure, unit-tested logic shared by the views.
   No DOM, no fetching, no Date.now() of its own (callers pass "now"), so
   tests/unit/season-utils.test.js can run this file in Node as-is. */
(function () {
  "use strict";

  /* Some corps compete in more than one class in a season (e.g. Open Class
     corps running World Class prelims at Championships). A single class's
     block then shows them with a one-point trend, no vs-prev delta, and a
     misleading season high. Stitching merges every class's history for each
     corps so delta / 3-show average / high / sparkline describe the ACTUAL
     season, while the row itself (score, date, event, rank) stays true to
     the class being shown. */
  function stitchSeasonHistory(standings, rows) {
    var hist = new Map(), best = new Map();
    Object.values(standings || {}).forEach(function (block) {
      (block.rows || []).forEach(function (r) {
        var h = hist.get(r.corps) || [];
        (r.trend || []).forEach(function (t) { h.push(t); });
        hist.set(r.corps, h);
        var b = best.get(r.corps);
        if (r.high != null && (!b || r.high > b.high))
          best.set(r.corps, { high: r.high, high_event: r.high_event, high_date: r.high_date });
      });
    });
    return rows.map(function (r) {
      var all = hist.get(r.corps);
      if (!all || !all.length) return r;
      // one point per date; this row's own show wins its date
      var byDate = new Map();
      all.forEach(function (t) {
        var cur = byDate.get(t[0]);
        if (cur == null || t[1] > cur) byDate.set(t[0], t[1]);
      });
      if (r.date) byDate.set(r.date, r.score);
      var trend = Array.from(byDate.entries()).sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });
      // the season high is the corps' best across every class, whether or not
      // the merged trend gained a point (their other class may have competed
      // on a date this one already covers)
      var b = best.get(r.corps) || {};
      var withHigh = (b.high == null || b.high === r.high) ? r : Object.assign({}, r, {
        high: b.high, high_event: b.high_event, high_date: b.high_date,
      });
      // compare contents, not just length: a corps can compete in two classes
      // on the SAME date, which replaces a point rather than adding one
      var unchanged = trend.length === (r.trend || []).length && trend.every(function (t, k) {
        return r.trend[k] && r.trend[k][0] === t[0] && r.trend[k][1] === t[1];
      });
      if (unchanged) return withHigh;
      var i = trend.findIndex(function (t) { return t[0] === r.date; });
      var prev = i > 0 ? trend[i - 1][1] : null;
      return Object.assign({}, withHigh, {
        trend: trend,
        prev_score: prev != null ? prev : r.prev_score,
        delta: prev != null ? +(r.score - prev).toFixed(3) : r.delta,
      });
    });
  }

  /* Prediction grading: exact spot = 3 pts, off by one = 1 pt. Graded only
     over the corps the fan actually called that competed, so a partial pick
     isn't crushed by the full-field size and a scratched corps just doesn't
     count. */
  function scorePred(predOrder, actual) {
    var pos = new Map(actual.map(function (c, i) { return [c, i]; }));
    var pts = 0, exact = 0, graded = 0;
    predOrder.forEach(function (corps, i) {
      var ap = pos.get(corps);
      if (ap == null) return;
      graded++;
      var d = Math.abs(ap - i);
      if (d === 0) { pts += 3; exact++; } else if (d === 1) pts += 1;
    });
    var max = graded * 3;
    return { pts: pts, max: max, exact: exact, n: graded, pct: max ? Math.round(pts / max * 100) : 0 };
  }

  /* Championship weekends run prelims, semis and finals — sometimes two of
     them on the SAME date. Plain date ordering then makes whichever the file
     happens to list last "the latest score", which put prelims results on top
     of same-day finals. Ranking the rounds keeps a corps' season in the order
     it was actually competed. (scraper/build_data.py applies the identical
     rule, so this mirror stays faithful.) */
  function roundRank(name) {
    var n = String(name || "");
    if (/prelim|quarter/i.test(n)) return 0;
    if (/semi/i.test(n)) return 1;
    return 2;
  }

  /* Build a rankings block for ONE past season from its events file — the
     browser-side mirror of scraper/build_data.py's build_rankings(), so a
     historical scoreboard is byte-for-byte the same shape as the live
     rankings.json the current season serves. Only used for past seasons; the
     current season always reads the pipeline's own file, untouched.

     Class filter: the archives label a handful of one-off oddities as
     "classes" ("Iiii", "Blockshow", "Dci Atlantic Competi" — parse residue
     from 50-year-old result pages). A division that really ran a season has
     several corps competing at more than one show, so a class needs
     minCorps corps AND minEvents events to be worth OFFERING as a board.
     Real historical divisions (Class A/B/C, All-Girl, Cadet, Corps Style…)
     all clear it; the residue doesn't. Filtered classes are still returned
     in `standings` — they are part of a corps' real season, and dropping
     them outright would hide results from stitchSeasonHistory and corrupt
     the season high / 3-show average / sparkline of corps that competed in
     both. `listClasses` is the subset worth showing in the class picker. */
  function rankingsFromEvents(events, opts) {
    var o = opts || {};
    var minCorps = o.minCorps == null ? 3 : o.minCorps;
    var minEvents = o.minEvents == null ? 2 : o.minEvents;
    var evs = (events || []).filter(function (e) { return e && e.date; })
      .slice().sort(function (a, b) {
        return String(a.date).localeCompare(String(b.date)) || roundRank(a.name) - roundRank(b.name);
      });
    var perClass = new Map();        // class -> Map(corps -> [{date, score, event}])
    var perClassEvents = new Map();  // class -> Set(event key)
    evs.forEach(function (ev) {
      (ev.classes || []).forEach(function (c) {
        var cls = c && c["class"];
        if (!cls) return;
        (c.results || []).forEach(function (r) {
          // falsy-score skip mirrors the Python builder (drops null AND 0)
          if (!r || !r.corps || !r.score) return;
          if (!perClass.has(cls)) { perClass.set(cls, new Map()); perClassEvents.set(cls, new Set()); }
          var byCorps = perClass.get(cls);
          if (!byCorps.has(r.corps)) byCorps.set(r.corps, []);
          byCorps.get(r.corps).push({ date: ev.date, score: r.score, event: ev.name });
          perClassEvents.get(cls).add(ev.date + "|" + ev.name);
        });
      });
    });
    var standings = {}, listClasses = [];
    perClass.forEach(function (byCorps, cls) {
      if (byCorps.size >= minCorps && perClassEvents.get(cls).size >= minEvents) listClasses.push(cls);
      var rows = [];
      byCorps.forEach(function (hist, corps) {
        hist.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
        var latest = hist[hist.length - 1];
        var prev = hist.length > 1 ? hist[hist.length - 2] : null;
        var hi = hist.reduce(function (best, x) { return x.score > best.score ? x : best; }, hist[0]);
        rows.push({
          corps: corps, score: latest.score, date: latest.date, event: latest.event,
          high: hi.score, high_event: hi.event, high_date: hi.date,
          prev_score: prev ? prev.score : null,
          delta: prev ? +(latest.score - prev.score).toFixed(3) : null,
          outings: hist.length,
          trend: hist.map(function (x) { return [x.date, x.score]; }).slice(-10),
        });
      });
      rows.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      rows.forEach(function (r, i) { r.rank = i + 1; });
      var movers = rows.filter(function (r) { return r.delta != null; })
        .sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); }).slice(0, 3);
      var battles = [];
      for (var i = 1; i < rows.length; i++) {
        var a = rows[i - 1], b = rows[i];
        battles.push({ a: a.corps, b: b.corps, ra: a.rank, rb: b.rank, sa: a.score, sb: b.score,
          gap: +(a.score - b.score).toFixed(3) });
      }
      battles.sort(function (x, y) { return x.gap - y.gap; });
      standings[cls] = { rows: rows, movers: movers, battles: battles.slice(0, 3) };
    });
    return {
      season: o.season != null ? o.season
        : (evs.length ? +String(evs[evs.length - 1].date).slice(0, 4) : null),
      standings: standings,     // every class — stitching needs the full picture
      listClasses: listClasses, // the ones worth offering as a standings board
      archived: true,           // built here rather than by the pipeline
    };
  }

  /* Days since the newest posted score across every class (Infinity if none).
     The tour never goes more than a few days dark mid-season, so >7 quiet
     days = the season is over — this drives the "final standings" framing
     and the off-season home module. */
  function daysSinceLastScore(rk, now) {
    var newest = "";
    Object.values((rk && rk.standings) || {}).forEach(function (b) {
      (b.rows || []).forEach(function (r) { if ((r.date || "") > newest) newest = r.date; });
    });
    if (!newest) return Infinity;
    var p = newest.split("-").map(Number);
    return (now - Date.UTC(p[0], p[1] - 1, p[2], 12)) / 86400000;
  }

  window.CadSeasonUtils = {
    stitchSeasonHistory: stitchSeasonHistory,
    scorePred: scorePred,
    daysSinceLastScore: daysSinceLastScore,
    rankingsFromEvents: rankingsFromEvents,
  };
})();
