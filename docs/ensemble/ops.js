/* Cadence Ensemble — operations runtime (calendar, events, attendance).
   Loaded after core.js by calendar.html and event.html.

   Three jobs:

   1. Formatting that matches the public Cadence apps, so a rehearsal on the
      private calendar reads the same way a show does on the public one.
   2. Shared rendering: event cards, RSVP controls, the attendance grid.
   3. THE COMPETITION BRIDGE — the reason this product exists.

   ── The bridge ────────────────────────────────────────────────────────
   organizations.public_app_key + public_ensemble_name say "this workspace
   is <ensemble> in <public Cadence app>". Every public app ships static
   JSON under docs/<app>/data/ :

     upcoming.json         [{name, date, date_display, location, url,
                             lineup?, schedule?}]
     seasons/<year>.json   [{name, date, date_display, location, url,
                             classes:[{class, results:[{place, corps, score,
                             rounds?, captions?}]}]}]

   So from the private side we can (a) offer real competitions when creating
   an event — venue and date prefilled, and (b) once a competition event is
   past, pull the ensemble's official placement and score straight out of the
   same dataset the public app renders. No API, no sync job: the private
   event stores public_app_key / public_event_key / public_event_date and we
   resolve them in the browser.

   Every fetch here is best-effort. An org with no public link, an app with
   no data for that year, a renamed show — all degrade to silence. */
(function () {
  "use strict";
  var esc = (window.CadOrg && CadOrg.esc) || function (s) { return String(s == null ? "" : s); };

  /* ═══ dates & times ═══════════════════════════════════════════════════
     Same voice as the public app: short weekday, month, day. Times are
     rendered in the viewer's local zone — a bus call at 5:40 AM is 5:40 AM
     wherever the parent is reading it. */

  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July",
                     "August", "September", "October", "November", "December"];

  function toDate(v) {
    if (v instanceof Date) return v;
    if (v == null || v === "") return null;
    // bare YYYY-MM-DD is a calendar date, not UTC midnight — keep it local
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      var p = v.split("-");
      return new Date(+p[0], +p[1] - 1, +p[2]);
    }
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function dayKey(v) {
    var d = toDate(v); if (!d) return "";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function fmtDay(v) {                       // "Sat, Sep 19"
    var d = toDate(v); if (!d) return "";
    return DAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate();
  }

  function fmtDayLong(v) {                   // "Saturday, September 19, 2026"
    var d = toDate(v); if (!d) return "";
    return DAYS_LONG[d.getDay()] + ", " + MONTHS_LONG[d.getMonth()] + " " +
      d.getDate() + ", " + d.getFullYear();
  }

  function fmtTime(v) {                      // "6:30 PM"
    var d = toDate(v); if (!d) return "";
    var h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + pad(m) + " " + ap;
  }

  function fmtWhen(ev) {                     // the one-line "when" for a card
    if (!ev || !ev.starts_at) return "";
    if (ev.all_day) {
      var e0 = toDate(ev.ends_at);
      if (e0 && dayKey(e0) !== dayKey(ev.starts_at)) {
        return fmtDay(ev.starts_at) + " – " + fmtDay(e0) + " · All day";
      }
      return "All day";
    }
    var s = fmtTime(ev.starts_at);
    var e = ev.ends_at ? toDate(ev.ends_at) : null;
    if (!e) return s;
    if (dayKey(e) !== dayKey(ev.starts_at)) return s + " → " + fmtDay(e) + " " + fmtTime(e);
    return s + " – " + fmtTime(e);
  }

  function relativeDay(v) {                  // "Today" / "In 3 days" / "2 weeks ago"
    var d = toDate(v); if (!d) return "";
    var a = new Date(); a.setHours(0, 0, 0, 0);
    var b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var n = Math.round((b - a) / 86400000);
    if (n === 0) return "Today";
    if (n === 1) return "Tomorrow";
    if (n === -1) return "Yesterday";
    if (n > 1 && n < 7) return "In " + n + " days";
    if (n < -1 && n > -7) return Math.abs(n) + " days ago";
    if (n >= 7 && n < 28) return "In " + Math.round(n / 7) + " week" + (n < 14 ? "" : "s");
    if (n <= -7 && n > -28) return Math.round(Math.abs(n) / 7) + " week" +
      (n > -14 ? "" : "s") + " ago";
    return fmtDay(d);
  }

  function isPast(ev) {
    var end = toDate(ev && (ev.ends_at || ev.starts_at));
    if (!end) return false;
    if (ev.all_day) { end = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59); }
    return end.getTime() < Date.now();
  }

  function isToday(ev) { return dayKey(ev && ev.starts_at) === dayKey(new Date()); }

  /* six-week matrix for the month grid, Sunday-first, always 42 cells */
  function monthMatrix(year, month) {
    var first = new Date(year, month, 1);
    var start = new Date(year, month, 1 - first.getDay());
    var out = [];
    for (var w = 0; w < 6; w++) {
      var row = [];
      for (var i = 0; i < 7; i++) {
        row.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i));
      }
      out.push(row);
    }
    return out;
  }

  /* a <input type="datetime-local"> value from a timestamptz, and back */
  function toLocalInput(v) {
    var d = toDate(v); if (!d) return "";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fromLocalInput(s) {
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /* ═══ event vocabulary ════════════════════════════════════════════════ */

  var KINDS = [
    { key: "rehearsal",   label: "Rehearsal",   icon: "🎯" },
    { key: "sectional",   label: "Sectional",   icon: "🎵" },
    { key: "competition", label: "Competition", icon: "🏆" },
    { key: "performance", label: "Performance", icon: "🎪" },
    { key: "game",        label: "Football game", icon: "🏈" },
    { key: "camp",        label: "Camp",        icon: "⛺" },
    { key: "meeting",     label: "Meeting",     icon: "🗓" },
    { key: "fundraiser",  label: "Fundraiser",  icon: "💛" },
    { key: "travel",      label: "Travel",      icon: "🚌" },
    { key: "audition",    label: "Audition",    icon: "🎧" },
    { key: "other",       label: "Other",       icon: "•" },
  ];
  var KIND_BY = {};
  KINDS.forEach(function (k) { KIND_BY[k.key] = k; });
  function kind(k) { return KIND_BY[k] || KIND_BY.other; }
  function kindLabel(k) { return kind(k).label; }

  var RSVP = [
    { key: "yes", label: "Going" },
    { key: "maybe", label: "Maybe" },
    { key: "no", label: "Can't" },
  ];

  var ATTENDANCE = [
    { key: "present",    label: "Present",    short: "P", tone: "good" },
    { key: "late",       label: "Late",       short: "L", tone: "warn" },
    { key: "excused",    label: "Excused",    short: "E", tone: "info" },
    { key: "left_early", label: "Left early", short: "LE", tone: "warn" },
    { key: "absent",     label: "Absent",     short: "A", tone: "bad" },
  ];
  var ATT_CYCLE = ["present", "absent", "late", "excused", "left_early"];
  function attNext(cur) {
    var i = ATT_CYCLE.indexOf(cur);
    return i < 0 ? ATT_CYCLE[0] : ATT_CYCLE[(i + 1) % ATT_CYCLE.length];
  }
  function attInfo(k) {
    for (var i = 0; i < ATTENDANCE.length; i++) if (ATTENDANCE[i].key === k) return ATTENDANCE[i];
    return null;
  }

  /* ═══ shared rendering ════════════════════════════════════════════════ */

  function mapLink(ev) {
    var q = (ev && (ev.address || ev.location)) || "";
    if (!q) return null;
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
  }

  function rsvpCounts(ev) {
    var c = { yes: 0, no: 0, maybe: 0 };
    (ev && ev.rsvps || []).forEach(function (r) {
      if (c[r.response] != null) c[r.response]++;
    });
    return c;
  }

  function myRsvp(ev, memberId) {
    var rows = (ev && ev.rsvps) || [];
    for (var i = 0; i < rows.length; i++) if (rows[i].member_id === memberId) return rows[i];
    return null;
  }

  /* One event card. Used by the calendar list, the month-grid day sheet and
     the "today" summary — same markup everywhere. */
  function eventCard(ev, opts) {
    opts = opts || {};
    var k = kind(ev.kind);
    var groups = opts.groupNames || {};
    var targets = (ev.targets || []).map(function (t) {
      return groups[t.group_id] || "a group";
    });
    var counts = rsvpCounts(ev);
    var mine = opts.memberId ? myRsvp(ev, opts.memberId) : null;
    var comp = ev.public_event_key
      ? '<span class="ens-tag important" title="Linked to a Cadence competition">🏆 Cadence show</span>'
      : "";
    var flags = [];
    if (ev.rsvp_required) flags.push("RSVP required");
    if (ev.attendance_required) flags.push("Attendance taken");

    var d = toDate(ev.starts_at);
    return '' +
      '<div class="ops-card" data-ev="' + esc(ev.id) + '">' +
        '<div class="ops-card-when">' +
          "<b>" + esc(MONTHS[d.getMonth()]) + "</b>" +
          "<i>" + d.getDate() + "</i>" +
          "<span>" + esc(DAYS[d.getDay()]) + "</span>" +
        "</div>" +
        '<div class="ops-card-body">' +
          '<a class="ops-card-title" href="event.html?id=' + esc(ev.id) + '">' + esc(ev.title) + "</a>" +
          '<div class="ops-card-meta">' + esc(k.icon + " " + k.label) + " · " + esc(fmtWhen(ev)) +
            (ev.location ? " · " + esc(ev.location) : "") + "</div>" +
          (targets.length
            ? '<div class="ops-card-meta">For: ' + esc(targets.join(", ")) + "</div>"
            : "") +
          '<div class="ops-card-tags">' + comp +
            flags.map(function (f) { return '<span class="ens-tag normal">' + esc(f) + "</span>"; }).join("") +
            (ev.rsvp_required
              ? '<span class="ens-tag normal">' + counts.yes + " going</span>"
              : "") +
            (mine && !opts.rsvp
              ? '<span class="ens-tag ' + (mine.response === "yes" ? "important" : "normal") + '">You: ' +
                esc(rsvpLabel(mine.response)) + "</span>"
              : "") +
          "</div>" +
          (opts.rsvp && ev.rsvp_required
            ? '<div class="ops-rsvp-slot" data-rsvp="' + esc(ev.id) + '"></div>'
            : "") +
        "</div>" +
      "</div>";
  }

  function rsvpLabel(r) {
    for (var i = 0; i < RSVP.length; i++) if (RSVP[i].key === r) return RSVP[i].label;
    return r || "";
  }

  /* The RSVP control. `onSet(response)` is called with 'yes'|'no'|'maybe';
     the caller does the write (so it can pick RPC vs. table). */
  function rsvpControl(host, current, onSet, opts) {
    opts = opts || {};
    host.innerHTML = '<div class="ops-rsvp">' + RSVP.map(function (r) {
      return '<button type="button" class="ops-rsvp-b' + (current === r.key ? " on " + r.key : "") +
        '" data-r="' + r.key + '"' + (opts.disabled ? " disabled" : "") + ">" + esc(r.label) + "</button>";
    }).join("") + "</div>" +
    (opts.note ? '<div class="ops-note">' + esc(opts.note) + "</div>" : "");
    if (opts.disabled) return;
    host.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-r]");
      if (!b) return;
      Array.prototype.forEach.call(host.querySelectorAll(".ops-rsvp-b"), function (x) {
        x.className = "ops-rsvp-b" + (x === b ? " on " + b.dataset.r : "");
      });
      onSet(b.dataset.r, b);
    });
  }

  /* ═══ modal sheet — reuses ensemble.css's .ens-sheet ══════════════════ */
  function sheet(title, bodyHtml, onMount) {
    var wrap = document.createElement("div");
    wrap.className = "ens-sheet";
    wrap.innerHTML = '<div class="ens-sheet-in" role="dialog" aria-modal="true">' +
      "<h3>" + esc(title) + "</h3>" +
      '<div class="ops-sheet-body">' + bodyHtml + "</div></div>";
    document.body.appendChild(wrap);
    function close() { wrap.remove(); }
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap) close();
      var c = e.target.closest && e.target.closest("[data-close]");
      if (c) { e.preventDefault(); close(); }
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    });
    if (onMount) onMount(wrap, close);
    return { el: wrap, close: close };
  }

  function toast(msg, bad) {
    var t = document.createElement("div");
    t.className = "ops-toast" + (bad ? " bad" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("out"); }, 2200);
    setTimeout(function () { t.remove(); }, 2700);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     THE COMPETITION BRIDGE
     ═══════════════════════════════════════════════════════════════════════ */

  var jsonCache = {};

  function appBase(appKey) {
    // pages live in docs/ensemble/, apps live at docs/ or docs/<key>/
    var k = (appKey == null ? "" : String(appKey)).replace(/^\/+|\/+$/g, "");
    return "../" + (k ? k + "/" : "");
  }

  function loadJson(url) {
    if (jsonCache[url]) return jsonCache[url];
    var p = fetch(url, { cache: "default" }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    }).catch(function () { return null; });
    jsonCache[url] = p;
    return p;
  }

  function hasPublicLink(org) {
    return !!(org && org.public_ensemble_name && org.public_app_key != null);
  }

  /* Name matching between a private workspace and a public dataset.
     Public datasets spell ensembles as they appear on the score sheet —
     "Carmel HS (IN)", "Avon High School", "2258 Trinity HS (PA)". */
  function normName(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/^\d+\s+/, "")                    // stray recap ID prefix
      .replace(/\((?:[a-z]{2}|[a-z .]+)\)\s*$/, "")  // trailing (IN) / (Indiana)
      .replace(/\bhigh school\b/g, "hs")
      .replace(/\bh\.?\s?s\.?\b/g, "hs")
      .replace(/\bsenior high\b/g, "hs")
      .replace(/\bmarching band\b/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "");
  }

  function nameMatches(a, b) {
    var x = normName(a), y = normName(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.length >= 6 && y.length >= 6 && (x.indexOf(y) === 0 || y.indexOf(x) === 0)) {
      return Math.min(x.length, y.length) / Math.max(x.length, y.length) >= 0.7;
    }
    return false;
  }

  function slugify(s) {
    return String(s == null ? "" : s).toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  }

  /* stable key for a public show: slug of its name (dates disambiguate) */
  function showKey(show) { return slugify(show && show.name); }

  function bridgeFor(org) {
    var key = org && org.public_app_key;
    var base = appBase(key);
    var who = org && org.public_ensemble_name;

    function season(year) { return loadJson(base + "data/seasons/" + year + ".json"); }
    function upcoming() { return loadJson(base + "data/upcoming.json"); }
    function meta() { return loadJson(base + "data/meta.json"); }

    /* Every show we could offer when creating an event: everything still
       ahead on the public calendar, plus this season's already-scored shows
       (a director adding last weekend's regional after the fact). */
    async function shows(opts) {
      opts = opts || {};
      var year = opts.year || new Date().getFullYear();
      var res = await Promise.all([upcoming(), season(year), opts.alsoPrevYear ? season(year - 1) : null]);
      var out = [];
      var seen = {};
      function push(s, scored) {
        if (!s || !s.name || !s.date) return;
        var id = showKey(s) + "|" + s.date;
        if (seen[id]) return;
        seen[id] = true;
        // upcoming shows publish a lineup; scored shows imply one from the
        // recap, so "shows we were in" works for past events too
        if (!s.lineup && s.classes) {
          s = Object.assign({}, s, {
            lineup: s.classes.reduce(function (acc, c) {
              (c.results || []).forEach(function (r) { if (r.corps) acc.push(r.corps); });
              return acc;
            }, []),
          });
        }
        out.push({
          key: showKey(s), name: s.name, date: s.date,
          date_display: s.date_display || fmtDayLong(s.date),
          location: s.location || "", url: s.url || null,
          scored: !!scored,
          lineup: s.lineup || null,
          schedule: s.schedule || null,
          app_key: key == null ? "" : key,
        });
      }
      (res[0] || []).forEach(function (s) { push(s, false); });
      (res[1] || []).forEach(function (s) { push(s, true); });
      (res[2] || []).forEach(function (s) { push(s, true); });
      out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      return out;
    }

    /* Shows this ensemble is actually named in — the ones a director cares
       about. Falls back to "everything" when the dataset has no lineups. */
    async function myShows(opts) {
      var all = await shows(opts);
      var mine = !who ? [] : all.filter(function (s) {
        if (s.lineup && s.lineup.length) {
          return s.lineup.some(function (n) { return nameMatches(n, who); });
        }
        return false;
      });
      return { mine: mine, all: all };
    }

    /* find a stored public_event_key/date back in the dataset */
    async function findShow(eventKey, date) {
      if (!eventKey || !date) return null;
      var year = String(date).slice(0, 4);
      var lists = [await season(year), await upcoming()];
      for (var i = 0; i < lists.length; i++) {
        var list = lists[i] || [];
        for (var j = 0; j < list.length; j++) {
          if (showKey(list[j]) === eventKey && String(list[j].date) === String(date)) return list[j];
        }
      }
      // date may have shifted (prelims/finals split) — fall back to key only
      for (var a = 0; a < lists.length; a++) {
        var l2 = lists[a] || [];
        for (var b = 0; b < l2.length; b++) if (showKey(l2[b]) === eventKey) return l2[b];
      }
      return null;
    }

    /* THE payoff: the ensemble's official result at a linked competition.
       Returns null (silently) when the show hasn't been scored yet, when the
       ensemble didn't compete, or when there's no public link at all. */
    async function resultFor(ev) {
      if (!who || !ev || !ev.public_event_key || !ev.public_event_date) return null;
      var show = await findShow(ev.public_event_key, ev.public_event_date);
      if (!show || !show.classes || !show.classes.length) return null;
      for (var c = 0; c < show.classes.length; c++) {
        var cls = show.classes[c];
        var rows = cls.results || [];
        for (var r = 0; r < rows.length; r++) {
          if (!nameMatches(rows[r].corps, who)) continue;
          return {
            show: { name: show.name, date: show.date, date_display: show.date_display,
                    location: show.location, url: show.url },
            className: cls.class || "",
            place: rows[r].place,
            score: rows[r].score,
            fieldSize: rows.length,
            rounds: rows[r].rounds || null,
            captions: rows[r].captions || null,
          };
        }
      }
      return null;
    }

    /* the ensemble's season so far — used for the "Today" summary header */
    async function seasonSoFar(year) {
      if (!who) return null;
      var list = await season(year || new Date().getFullYear());
      if (!list) return null;
      var out = [];
      list.forEach(function (show) {
        (show.classes || []).forEach(function (cls) {
          (cls.results || []).forEach(function (row) {
            if (nameMatches(row.corps, who)) {
              out.push({ name: show.name, date: show.date, place: row.place,
                         score: row.score, className: cls.class || "" });
            }
          });
        });
      });
      out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      return out;
    }

    return {
      linked: hasPublicLink(org),
      appKey: key == null ? "" : key,
      ensembleName: who || null,
      base: base,
      shows: shows, myShows: myShows, findShow: findShow,
      resultFor: resultFor, seasonSoFar: seasonSoFar, meta: meta,
    };
  }

  /* render a resolved competition result as a card body */
  function resultHtml(res) {
    if (!res) return "";
    var caps = res.captions ? Object.keys(res.captions).map(function (c) {
      return '<div><b>' + esc(res.captions[c]) + "</b><span>" + esc(c.toUpperCase()) + "</span></div>";
    }).join("") : "";
    var rounds = res.rounds ? Object.keys(res.rounds).map(function (r) {
      return '<div><b>' + esc(res.rounds[r]) + "</b><span>" + esc(r) + "</span></div>";
    }).join("") : "";
    return '' +
      '<div class="ops-result">' +
        '<div class="ops-result-head">' +
          '<div class="ops-place">' + (res.place ? "#" + esc(res.place) : "—") + "</div>" +
          "<div><b>" + esc(res.score != null ? Number(res.score).toFixed(3) : "—") + "</b>" +
          "<span>" + esc(res.className || "") +
          (res.fieldSize ? " · of " + res.fieldSize : "") + "</span></div>" +
        "</div>" +
        (rounds ? '<div class="ens-stat ops-mini">' + rounds + "</div>" : "") +
        (caps ? '<div class="ens-stat ops-mini">' + caps + "</div>" : "") +
        '<div class="ops-note">Official result from Cadence' +
          (res.show && res.show.url
            ? ' · <a href="' + esc(res.show.url) + '" target="_blank" rel="noopener">recap</a>'
            : "") + "</div>" +
      "</div>";
  }

  /* ═══ the create/edit event form ══════════════════════════════════════
     Shared by calendar.html and event.html so the two can never disagree
     about what an event is. ctx = { org, groups, seasons, bridge, onSaved }.
     Pass ev to edit, null to create; defaultDay ("YYYY-MM-DD") preselects a
     date when creating from the month grid. */
  function eventForm(ctx, ev, defaultDay) {
    var org = ctx.org, groups = ctx.groups || [], seasons = ctx.seasons || [];
    var bridge = ctx.bridge;
    var editing = !!ev;
    var link = {
      app: ev ? ev.public_app_key : null,
      key: ev ? ev.public_event_key : null,
      date: ev ? ev.public_event_date : null,
      name: null,
    };
    var start = ev ? toLocalInput(ev.starts_at)
      : (defaultDay ? defaultDay + "T18:00" : toLocalInput(new Date()).slice(0, 11) + "18:00");
    var targets = ev ? (ev.targets || []).map(function (t) { return t.group_id; }) : [];

    var body =
      '<div class="ops-f"><label for="eTitle">Title</label>' +
        '<input class="ctrl" id="eTitle" maxlength="140" value="' + esc(ev ? ev.title : "") + '"></div>' +
      '<div class="ops-f2"><div class="ops-f"><label for="eKind">Kind</label>' +
        '<select class="ctrl" id="eKind">' + KINDS.map(function (k) {
          return '<option value="' + k.key + '"' + (ev && ev.kind === k.key ? " selected" : "") +
            ">" + esc(k.icon + " " + k.label) + "</option>"; }).join("") + "</select></div>" +
        '<div class="ops-f"><label for="eSeason">Season</label>' +
        '<select class="ctrl" id="eSeason"><option value="">—</option>' + seasons.map(function (s) {
          var on = ev ? ev.season_id === s.id : s.is_current;
          return '<option value="' + s.id + '"' + (on ? " selected" : "") + ">" + esc(s.name) + "</option>";
        }).join("") + "</select></div></div>" +
      '<div class="ops-f2"><div class="ops-f"><label for="eStart">Starts</label>' +
        '<input class="ctrl" id="eStart" type="datetime-local" value="' + esc(start) + '"></div>' +
        '<div class="ops-f"><label for="eEnd">Ends</label>' +
        '<input class="ctrl" id="eEnd" type="datetime-local" value="' +
        esc(ev && ev.ends_at ? toLocalInput(ev.ends_at) : "") + '"></div></div>' +
      '<label class="ops-check"><input type="checkbox" id="eAllDay"' +
        (ev && ev.all_day ? " checked" : "") + "> All day</label>" +
      '<div class="ops-f"><label for="eLoc">Location</label>' +
        '<input class="ctrl" id="eLoc" maxlength="140" value="' + esc(ev ? (ev.location || "") : "") + '"></div>' +
      '<div class="ops-f"><label for="eAddr">Address (for the map link)</label>' +
        '<input class="ctrl" id="eAddr" maxlength="200" value="' + esc(ev ? (ev.address || "") : "") + '"></div>' +
      '<div class="ops-f"><label for="eDesc">Details</label>' +
        '<textarea class="ctrl" id="eDesc" rows="3">' + esc(ev ? (ev.description || "") : "") + "</textarea></div>" +
      '<label class="ops-check"><input type="checkbox" id="eRsvp"' +
        (ev && ev.rsvp_required ? " checked" : "") + "> Ask everyone to RSVP</label>" +
      '<label class="ops-check"><input type="checkbox" id="eAtt"' +
        (ev && ev.attendance_required ? " checked" : "") + "> Take attendance at this event</label>" +
      '<div class="ops-f"><label>Who is it for?</label>' +
        '<div class="ops-picks">' + groups.map(function (g) {
          return '<label class="ops-pick"><input type="checkbox" class="eGrp" value="' + g.id + '"' +
            (targets.indexOf(g.id) >= 0 ? " checked" : "") + ">" + esc(g.name) + "</label>";
        }).join("") + "</div>" +
        '<div class="ops-note">Leave every box unchecked and the event is for the whole organization.</div></div>' +
      '<div class="ops-f"><label>Cadence competition</label><div id="eLinkBox"></div></div>' +
      '<p class="acct-msg" id="eMsg" role="status"></p>' +
      '<div class="ops-actions">' +
        '<button class="tab on grow" type="button" id="eSave">' +
          (editing ? "Save changes" : "Create event") + "</button>" +
        '<button class="tab" type="button" data-close>Cancel</button>' +
        (editing ? '<button class="tab ops-danger" type="button" id="eDel">Delete</button>' : "") +
      "</div>";

    return sheet(editing ? "Edit event" : "New event", body, function (wrap, close) {
      var linkBox = wrap.querySelector("#eLinkBox");

      function paintLink() {
        if (!bridge || !bridge.linked) {
          linkBox.innerHTML = '<div class="ops-note">This workspace isn\'t linked to a public ' +
            "Cadence ensemble yet, so real competitions can't be pulled in. An admin can set the " +
            "public app and ensemble name in workspace settings — then venues, dates and official " +
            "scores arrive here on their own.</div>";
          return;
        }
        linkBox.innerHTML = link.key
          ? '<div class="ops-showrow"><b>🏆 ' + esc(link.name || link.key) + "</b>" +
            "<span>" + esc(link.date || "") + " · official results will appear on this event</span></div>" +
            '<button class="tab" type="button" id="eUnlink">Remove link</button>'
          : '<button class="tab" type="button" id="ePick">+ Add a Cadence competition</button>' +
            '<div class="ops-note">Pick a real show — the title, venue and date fill themselves in. ' +
            "Once it's scored, your placement shows up on this event.</div>";
        var pb = linkBox.querySelector("#ePick");
        if (pb) pb.addEventListener("click", pickShow);
        var ub = linkBox.querySelector("#eUnlink");
        if (ub) ub.addEventListener("click", function () {
          link = { app: null, key: null, date: null, name: null }; paintLink();
        });
      }

      function pickShow() {
        var picker = sheet("Cadence competitions", '<div class="loading">Loading shows…</div>');
        var host = picker.el.querySelector(".ops-sheet-body");
        bridge.myShows({ alsoPrevYear: true }).then(function (r) {
          var all = r.all || [];
          function rows(list) {
            return list.map(function (sh) {
              return '<button type="button" class="ops-showrow" data-k="' + esc(sh.key) +
                '" data-d="' + esc(sh.date) + '"><b>' + esc(sh.name) + "</b><span>" +
                esc(sh.date_display) + (sh.location ? " · " + esc(sh.location) : "") +
                (sh.scored ? " · scored" : "") + "</span></button>";
            }).join("");
          }
          if (!all.length) {
            host.innerHTML = '<div class="empty">No shows in that app\'s public data yet.</div>' +
              '<div class="ops-actions"><button class="tab" type="button" data-close>Close</button></div>';
            return;
          }
          host.innerHTML =
            (r.mine && r.mine.length
              ? "<h4>" + esc(bridge.ensembleName) + " is in the lineup</h4>" + rows(r.mine)
              : "") +
            "<h4>All shows</h4>" + rows(all) +
            '<div class="ops-actions"><button class="tab" type="button" data-close>Close</button></div>';
          host.addEventListener("click", function (e) {
            var b = e.target.closest && e.target.closest("[data-k]");
            if (!b) return;
            var sh = all.filter(function (x) {
              return x.key === b.dataset.k && x.date === b.dataset.d; })[0];
            if (!sh) return;
            link = { app: bridge.appKey, key: sh.key, date: sh.date, name: sh.name };
            if (!wrap.querySelector("#eTitle").value) wrap.querySelector("#eTitle").value = sh.name;
            wrap.querySelector("#eKind").value = "competition";
            if (sh.location) wrap.querySelector("#eLoc").value = sh.location;
            var cur = wrap.querySelector("#eStart").value;
            wrap.querySelector("#eStart").value = sh.date + "T" + ((cur && cur.slice(11)) || "17:00");
            picker.close();
            paintLink();
          });
        });
      }

      paintLink();

      wrap.querySelector("#eSave").addEventListener("click", async function () {
        var msg = wrap.querySelector("#eMsg");
        var title = wrap.querySelector("#eTitle").value.trim();
        var startsAt = fromLocalInput(wrap.querySelector("#eStart").value);
        if (!title) { msg.className = "acct-msg err"; msg.textContent = "Give it a title."; return; }
        if (!startsAt) { msg.className = "acct-msg err"; msg.textContent = "Pick a start time."; return; }
        msg.className = "acct-msg"; msg.textContent = "Saving…";

        var picks = Array.prototype.map.call(wrap.querySelectorAll(".eGrp:checked"),
          function (c) { return c.value; });
        var payload = {
          org_id: org.id,
          season_id: wrap.querySelector("#eSeason").value || null,
          title: title,
          kind: wrap.querySelector("#eKind").value,
          starts_at: startsAt,
          ends_at: fromLocalInput(wrap.querySelector("#eEnd").value),
          all_day: wrap.querySelector("#eAllDay").checked,
          location: wrap.querySelector("#eLoc").value.trim() || null,
          address: wrap.querySelector("#eAddr").value.trim() || null,
          description: wrap.querySelector("#eDesc").value.trim() || null,
          rsvp_required: wrap.querySelector("#eRsvp").checked,
          attendance_required: wrap.querySelector("#eAtt").checked,
          public_app_key: link.key ? link.app : null,
          public_event_key: link.key || null,
          public_event_date: link.date || null,
        };
        try {
          var newId = null;
          if (editing) {
            await CadOrg.rest("org_events?id=eq." + ev.id, { method: "PATCH", body: payload });
            await CadOrg.rest("org_event_targets?event_id=eq." + ev.id, { method: "DELETE" });
            if (picks.length) {
              await CadOrg.rest("org_event_targets", { method: "POST",
                body: picks.map(function (g) { return { event_id: ev.id, group_id: g }; }) });
            }
            CadOrg.log("event.updated", "event", ev.id);
          } else {
            newId = await CadOrg.rpc("org_event_create", { p_event: payload, p_groups: picks });
          }
          close();
          toast(editing ? "Event updated" : "Event created");
          if (ctx.onSaved) ctx.onSaved(editing ? ev.id : newId, editing);
        } catch (err) {
          msg.className = "acct-msg err";
          msg.textContent = "Couldn't save: " + ((err && err.message) || "unknown error");
        }
      });

      var del = wrap.querySelector("#eDel");
      if (del) del.addEventListener("click", async function () {
        if (!window.confirm("Delete “" + ev.title + "”? RSVPs and attendance for it go too.")) return;
        try {
          await CadOrg.rest("org_events?id=eq." + ev.id, { method: "DELETE" });
          CadOrg.log("event.deleted", "event", ev.id);
          close();
          toast("Event deleted");
          if (ctx.onDeleted) ctx.onDeleted(ev.id);
          else if (ctx.onSaved) ctx.onSaved(null, false);
        } catch (err) { toast("Couldn't delete that event", true); }
      });
    });
  }

  /* ═══ misc ════════════════════════════════════════════════════════════ */

  function qs(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }

  /* plan gating: never hide a feature, explain it */
  function gate(org, feature) {
    var ok = window.CadOrg ? CadOrg.canUseFeature(org, feature) : false;
    return {
      ok: ok,
      note: ok ? "" :
        "Included with Cadence Ensemble Pro. Everything you've already entered stays put.",
    };
  }

  function lockedCard(title, feature, org) {
    var g = gate(org, feature);
    return '<div class="card ens-locked"><div class="ens-h"><h2>' + esc(title) + "</h2>" +
      '<span class="ens-tag normal">Pro</span></div>' +
      '<p class="ens-lock-note">' + esc(g.note) +
      ' <a href="billing.html">See plans →</a></p></div>';
  }

  window.CadOps = {
    // dates
    toDate: toDate, dayKey: dayKey, fmtDay: fmtDay, fmtDayLong: fmtDayLong,
    fmtTime: fmtTime, fmtWhen: fmtWhen, relativeDay: relativeDay,
    monthMatrix: monthMatrix, toLocalInput: toLocalInput, fromLocalInput: fromLocalInput,
    isPast: isPast, isToday: isToday, MONTHS: MONTHS, MONTHS_LONG: MONTHS_LONG,
    DAYS: DAYS, DAYS_LONG: DAYS_LONG,
    // vocabulary
    KINDS: KINDS, kind: kind, kindLabel: kindLabel, RSVP: RSVP, rsvpLabel: rsvpLabel,
    ATTENDANCE: ATTENDANCE, attNext: attNext, attInfo: attInfo,
    // rendering
    eventCard: eventCard, rsvpControl: rsvpControl, rsvpCounts: rsvpCounts, myRsvp: myRsvp,
    mapLink: mapLink, sheet: sheet, toast: toast, resultHtml: resultHtml,
    eventForm: eventForm,
    // bridge
    bridge: bridgeFor, hasPublicLink: hasPublicLink, nameMatches: nameMatches,
    normName: normName, showKey: showKey, slugify: slugify, loadJson: loadJson,
    appBase: appBase,
    // misc
    qs: qs, gate: gate, lockedCard: lockedCard,
  };
})();
