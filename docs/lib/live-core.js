/* Cadence live-show core — the pure math behind every LIVE pill.
   No fetching, no clocks of its own: callers pass today's data and "now",
   which is what makes this file unit-testable (tests/unit/live-core.test.js
   runs it in Node with a controlled clock). app.js's LIVE module owns the
   fetching/caching and delegates the decisions here.

   The rules, exactly as shipped:
   - a corps is live for ±PAD around its schedule slot until its score posts;
   - logistics rows (gates, anthem, intermission…) never drive per-corps
     pills or completeness, but the show window spans the full schedule;
   - the instant every real performing corps has a score, the entire show —
     logistics rows included — goes dark, wherever the clock sits;
   - a show with no scores simply expires after its last slot + PAD. */
(function () {
  "use strict";
  var LIVE_PAD = 15 * 60000; // ±15 min around a performance slot
  var NON_CORPS = /gates?\s*open|doors?\s*open|will\s*call|box\s*office|welcome|national\s*anthem|opening\s*ceremon|closing\s*ceremon|intermission|scores?\s*announced|awards?|retreat|encore|age.?out|honor\s*guard|pledge|drum\s*major|autograph|loge|terrace|reserved\s*seating|takes\s*effect|levels?\s*open|lot\s*opens?|parking|(semi.?finals?|quarter.?finals?|finals?|prelims?|competition|show|program)\s*(begins?|resumes?|concludes?|starts?|ends?)|lunch|dinner|\bbreak\b/i;

  /* "7:30 PM" at the venue → UTC ms.
     A hardcoded +4 assumed every show runs Eastern Daylight Time. That is
     three hours wrong at a west-coast venue and one hour wrong outside EDT,
     and app.js converts the DISPLAYED start time properly via
     tzOffsetMin(venueZone(location)) — so the LIVE pill and the printed start
     time disagreed, which is the disagreement this conversion exists to end.
     The venue's IANA zone gives the right offset for that specific date,
     daylight saving included. Defaults to Eastern, where DCI championships
     run, when the caller has no location to derive a zone from. */
  function tzOffsetMin(tz, date) {
    var parts = {};
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false, year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(date).forEach(function (x) { parts[x.type] = x.value; });
    var asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
    return (asUTC - date.getTime()) / 60000;
  }

  function slotMs(dateISO, timeStr, tz) {
    var m = /(\d{1,2}):(\d{2})\s*([ap])\.?m/i.exec(String(timeStr || ""));
    if (!m) return null;
    var h = (+m[1]) % 12; if (/p/i.test(m[3])) h += 12;
    var p = String(dateISO || "").split("-").map(Number);
    if (p.length !== 3 || p.some(isNaN)) return null;
    var zone = tz || "America/New_York";
    var utc = Date.UTC(p[0], p[1] - 1, p[2], h, +m[2]);
    try {
      return utc - tzOffsetMin(zone, new Date(utc)) * 60000;
    } catch (e) {
      return utc - tzOffsetMin("America/New_York", new Date(utc)) * 60000;
    }
  }

  function slotLiveAt(dateISO, timeStr, now, tz) {
    var t = slotMs(dateISO, timeStr, tz);
    return t != null && now >= t - LIVE_PAD && now <= t + LIVE_PAD;
  }

  /* compute(upcoming, seasonEvents, todayISO, nowMs) →
     { corpsLive, showLive, complete, scored } (Sets of names).
     upcoming: today's shows with .date/.schedule([[time, entry]…])/.lineup;
     seasonEvents: the season file, for which corps already have scores today. */
  function compute(up, season, today, now) {
    var scoredToday = new Set();
    var scoredByShow = {};
    (season || []).forEach(function (e) {
      if (e.date !== today) return;
      var n = 0;
      (e.classes || []).forEach(function (c) {
        (c.results || []).forEach(function (r) {
          if (r.score != null) { scoredToday.add(r.corps); n++; }
        });
      });
      scoredByShow[e.name] = (scoredByShow[e.name] || 0) + n;
    });
    var corpsLive = new Set(), showLive = new Set(), complete = new Set();
    (up || []).forEach(function (ev) {
      if (ev.date !== today || !Array.isArray(ev.schedule)) return;
      var lineup = new Set(ev.lineup || []);
      var realSlots = ev.schedule.filter(function (p) { return p && lineup.has(p[1]) && !NON_CORPS.test(p[1]); });
      var realCorps = new Set(realSlots.map(function (p) { return p[1]; }));
      if (realCorps.size && (scoredByShow[ev.name] || 0) >= realCorps.size) { complete.add(ev.name); return; }
      realSlots.forEach(function (pair) {
        var t = slotMs(ev.date, pair[0], ev.tz); if (t == null) return;
        if (now >= t - LIVE_PAD && now <= t + LIVE_PAD && !scoredToday.has(pair[1])) corpsLive.add(pair[1]);
      });
      var times = ev.schedule.map(function (p) { return slotMs(ev.date, p[0], ev.tz); }).filter(function (t) { return t != null; });
      if (times.length) {
        var first = Math.min.apply(null, times), last = Math.max.apply(null, times);
        if (now >= first - LIVE_PAD && now <= last + LIVE_PAD) showLive.add(ev.name);
      }
    });
    return { corpsLive: corpsLive, showLive: showLive, complete: complete, scored: scoredToday };
  }

  window.CadLiveCore = { LIVE_PAD: LIVE_PAD, NON_CORPS: NON_CORPS, tzOffsetMin: tzOffsetMin,
    slotMs: slotMs, slotLiveAt: slotLiveAt, compute: compute };
})();
