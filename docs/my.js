/* My Cadence — the personalized home for the whole Cadence family.
   One page, two halves that share one account:

   PUBLIC — favorites starred in any scoreboard app (each app keeps
   its own "<ns>cad-favs" list in localStorage; account.js mirrors them to the
   signed-in account). This page reads every namespace, fetches static JSON
   only for the circuits the user actually follows (rankings.json +
   upcoming.json per app, in parallel, session-cached), and builds:
   Next up · Recent results · Ranking movers · Your ensembles.

   PRIVATE — Cadence Ensemble workspaces (Supabase). A lightweight PostgREST
   reader reuses the session token account.js persists; every private query
   fails silently (missing tables, signed out, offline) so the public half
   always renders. Private content is visually its own species: violet accent,
   lock badges, workspace names on every row.

   No build step; plain script, ES5-safe patterns like account.js/core.js. */
(function () {
  "use strict";
  var app = document.getElementById("app");
  if (!app) return;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var slugOf = function (name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  };
  var ORD = function (n) {
    n = Math.round(n);
    var s = ["th", "st", "nd", "rd"], k = n % 100;
    return n + (s[(k - 20) % 10] || s[k] || s[0]);
  };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* stroke icons in the app's shared visual language — no emoji */
  function sic(d) {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
      'style="vertical-align:-2px"><path d="' + d + '"/></svg>';
  }
  var IC = {
    scores: "M5 20V12M12 20V5M19 20v-6M3 20h18",                       // bar chart
    guard:  "M6 21V3.5M6 4h11l-2.5 3.5L17 11H6",                       // flag
    perc:   "M4 9c0-1.7 3.6-3 8-3s8 1.3 8 3M4 9v7c0 1.7 3.6 3 8 3s8-1.3 8-3V9M4 9c0 1.7 3.6 3 8 3s8-1.3 8-3M7.5 4l3 5.5M16.5 4l-3 5.5",
    winds:  "M7 4v11.5M7 4l4 1v3L7 7M7 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM13 8c2 1 5 4 4 8-.6 2.4-2.8 4-5 4",
    space:  "M4 6h7v12H4zM13 6h7v7h-7zM13 17h7",                       // workspace panes
  };

  /* ── the family, from the one registry — EVERY deployed app, listed or
     not, so a star placed on BOA or UIL shows up here too. Icons stay
     local (they're this page's visual language); everything else comes
     from docs/registry.js. Falls back to the core four if the registry
     script is missing. ─────────────────────────────────────────────── */
  var APP_ICON = { dci: IC.scores, "wgi-guard": IC.guard, "wgi-perc": IC.perc, "wgi-winds": IC.winds };
  var APPS = (window.CAD_REGISTRY ? CAD_REGISTRY.apps : [
    { id: "dci", ns: "", name: "DCI", short: "DCI", path: "", term: "corps" },
    { id: "wgi-guard", ns: "wgi-guard:", name: "WGI Color Guard", short: "WGI CG", path: "wgi/guard/", term: "guards" },
    { id: "wgi-perc", ns: "wgi-perc:", name: "WGI Percussion", short: "WGI Pc", path: "wgi/percussion/", term: "ensembles" },
    { id: "wgi-winds", ns: "wgi-winds:", name: "WGI Winds", short: "WGI Wd", path: "wgi/winds/", term: "ensembles" },
  ]).map(function (a) {
    return { key: a.id, ns: a.ns, name: a.name, tag: a.short,
             icon: sic(APP_ICON[a.id] || IC.scores),
             path: a.path === "" ? "./" : a.path, term: a.term };
  });

  function favsOf(a) {
    try { var v = JSON.parse(localStorage.getItem(a.ns + "cad-favs") || "[]"); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  var FOLLOW_KEY = "cad-my-follow"; // circuits followed by chip (may have no stars yet)
  function followed() {
    try { var v = JSON.parse(localStorage.getItem(FOLLOW_KEY) || "[]"); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function setFollowed(list) {
    try { localStorage.setItem(FOLLOW_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function isActive(a) { return favsOf(a).length > 0 || followed().indexOf(a.key) >= 0; }

  /* ── fetch layer: parallel, silent on 404, cached per session ────────── */
  var mem = {};                       // in-page dedupe
  var SKEY = "cad-my-v1:";            // sessionStorage cache prefix
  var TTL = 10 * 60000;               // fresh enough for a show night
  function getJson(url) {
    if (mem[url]) return mem[url];
    var hit = null;
    try {
      var raw = sessionStorage.getItem(SKEY + url);
      if (raw) { var rec = JSON.parse(raw); if (rec && Date.now() - rec.t < TTL) hit = rec.j; }
    } catch (e) {}
    mem[url] = hit != null ? Promise.resolve(hit)
      : fetch(url).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
        .then(function (j) {
          try { sessionStorage.setItem(SKEY + url, JSON.stringify({ t: Date.now(), j: j })); } catch (e) {}
          return j;
        })
        .catch(function () { return null; }); // missing data file = that app contributes nothing
    return mem[url];
  }
  function appData(a) { // exactly two fetches per followed app
    return Promise.all([
      getJson(a.path + "data/rankings.json"),
      getJson(a.path + "data/upcoming.json"),
    ]).then(function (r) { return { app: a, rk: r[0], up: r[1] }; });
  }

  /* ── formatting ──────────────────────────────────────────────────────── */
  function todayISO() { // local date, not UTC
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).replace(/^(\d)$/, "0$1") +
      "-" + String(d.getDate()).replace(/^(\d)$/, "0$1");
  }
  function dstack(iso) {
    if (!iso) return "";
    var p = iso.split("-");
    return "<b>" + MONTHS[(+p[1] || 1) - 1] + " " + (+p[2] || "") + "</b><small>" + p[0] + "</small>";
  }
  function scoreDisp(r) { // scores, UIL ratings and ISSMA placements all ride here
    if (r.score != null) return (+r.score).toFixed(3);
    if (r.rating != null) {
      var roman = ["", "I", "II", "III", "IV", "V"][Math.round(r.rating)] || String(r.rating);
      return r.rating_label ? roman + " · " + r.rating_label : roman;
    }
    if (r.placement != null) return ORD(r.placement);
    return "—";
  }
  function deltaDisp(d) {
    if (d == null || !isFinite(d)) return "";
    var cls = d > 0 ? "up" : d < 0 ? "down" : "flat";
    var arrow = d > 0 ? "▲" : d < 0 ? "▼" : "—";
    return '<span class="delta ' + cls + '">' + arrow + " " + (d > 0 ? "+" : "") + (+d).toFixed(3) + "</span>";
  }
  function appdot(a) { return '<span class="appdot">' + a.icon + " " + esc(a.tag) + "</span>"; }
  function joinNames(names, max) {
    var shown = names.slice(0, max);
    var out = shown.map(esc).join(", ");
    if (names.length > max) out += " +" + (names.length - max);
    return out;
  }

  /* ── collect the public story out of the fetched apps ────────────────── */
  function collect(datas) {
    var today = todayISO();
    var nextUp = [], results = [], favGroups = [];
    datas.forEach(function (d) {
      var a = d.app, favs = favsOf(a);
      var favSet = {};
      favs.forEach(function (n) { favSet[n] = true; });

      if (favs.length) favGroups.push({ app: a, favs: favs });

      // latest result per favorite straight from rankings.json — score, event,
      // date, current rank and movement all live on the standings row
      if (d.rk && d.rk.standings) {
        Object.keys(d.rk.standings).forEach(function (cls) {
          var rows = (d.rk.standings[cls] || {}).rows || [];
          rows.forEach(function (r) {
            if (!favSet[r.corps] || !r.date) return;
            results.push({ app: a, cls: cls, r: r });
          });
        });
      }

      // upcoming shows featuring favorites; when no lineup mentions them yet
      // (or the circuit is followed without stars), the circuit's next two
      // shows stand in so "Next up" is never a dead end
      if (Array.isArray(d.up)) {
        var future = d.up.filter(function (ev) { return ev && ev.date && ev.date >= today; });
        var found = 0;
        future.forEach(function (ev) {
          var lineup = Array.isArray(ev.lineup) ? ev.lineup : [];
          var mine = lineup.filter(function (n) { return favSet[n]; });
          if (mine.length) { nextUp.push({ app: a, ev: ev, favs: mine }); found++; }
        });
        if (!found) future.slice(0, 2).forEach(function (ev) { nextUp.push({ app: a, ev: ev, favs: [] }); });
      }
    });
    nextUp.sort(function (x, y) { return x.ev.date < y.ev.date ? -1 : x.ev.date > y.ev.date ? 1 : 0; });
    results.sort(function (x, y) { return x.r.date < y.r.date ? 1 : x.r.date > y.r.date ? -1 : 0; });
    var movers = results.filter(function (x) { return x.r.delta != null && isFinite(x.r.delta) && x.r.delta !== 0; })
      .slice().sort(function (x, y) { return Math.abs(y.r.delta) - Math.abs(x.r.delta); });
    return { nextUp: nextUp, results: results, movers: movers, favGroups: favGroups };
  }

  /* ── html builders — public half ─────────────────────────────────────── */
  function card(title, sub, body, extraClass) {
    return '<div class="card' + (extraClass ? " " + extraClass : "") + '"><h2>' + title +
      (sub ? ' <span class="sub">' + sub + "</span>" : "") + "</h2>" + body + "</div>";
  }
  function emptyRow(msg) { return '<div class="empty" style="padding:18px 8px">' + msg + "</div>"; }

  function nextUpHtml(items) {
    if (!items.length) return emptyRow("No upcoming shows for your favorites right now.");
    return items.slice(0, 8).map(function (it) {
      var ev = it.ev;
      return '<a class="my-item" href="' + esc(it.app.path) + '#/events">' +
        '<span class="my-when">' + dstack(ev.date) + "</span>" +
        '<span class="my-main"><b>' + esc(ev.name) + "</b>" +
        (ev.location ? '<span class="sub">' + esc(ev.location) + "</span>" : "") +
        (it.favs.length ? '<span class="favline">★ ' + joinNames(it.favs, 3) + "</span>"
          : '<span class="sub">next up in this circuit</span>') +
        "</span>" + appdot(it.app) + "</a>";
    }).join("");
  }

  function resultsHtml(items) {
    if (!items.length) return emptyRow("Star favorites in any scoreboard and their latest scores land here.");
    return items.slice(0, 9).map(function (it) {
      var r = it.r;
      return '<a class="my-item" href="' + esc(it.app.path) + "#/corps/" + esc(slugOf(r.corps)) + '">' +
        '<span class="my-when">' + dstack(r.date) + "</span>" +
        '<span class="my-main"><b>★ ' + esc(r.corps) + "</b>" +
        '<span class="sub">' + esc(r.event || "") + "</span>" +
        '<span class="sub">#' + esc(r.rank) + " · " + esc(it.cls) + "</span></span>" +
        '<span class="my-num"><span class="score">' + esc(scoreDisp(r)) + "</span>" +
        '<span class="sub">' + esc(it.app.tag) + "</span></span></a>";
    }).join("");
  }

  function moversHtml(items) {
    if (!items.length) return emptyRow("Once your favorites have two scored outings, movement shows up here.");
    return items.slice(0, 8).map(function (it) {
      var r = it.r;
      return '<a class="my-item" href="' + esc(it.app.path) + "#/corps/" + esc(slugOf(r.corps)) + '">' +
        '<span class="my-main"><b>' + esc(r.corps) + "</b>" +
        '<span class="sub">#' + esc(r.rank) + " " + esc(it.cls) + " · last: " + esc(scoreDisp(r)) + "</span></span>" +
        '<span class="my-num"><span class="score">' + deltaDisp(r.delta) + "</span>" +
        '<span class="sub">' + esc(it.app.tag) + "</span></span></a>";
    }).join("");
  }

  function favGroupsHtml(groups) {
    if (!groups.length) return emptyRow("No favorites yet — open any scoreboard below and tap the ★.");
    return groups.map(function (g) {
      return '<div style="margin-bottom:10px"><div class="kicker" style="margin:2px 0 6px">' +
        g.app.icon + " " + esc(g.app.name) + "</div>" +
        '<div class="my-chips">' + g.favs.map(function (n) {
          return '<a class="my-chip on" style="text-decoration:none" href="' + esc(g.app.path) +
            "#/corps/" + esc(slugOf(n)) + '">' + esc(n) + "</a>";
        }).join("") + "</div></div>";
    }).join("");
  }

  function chipsHtml() {
    var fl = followed();
    return '<div class="my-chips">' + APPS.map(function (a) {
      var stars = favsOf(a).length;
      var on = stars > 0 || fl.indexOf(a.key) >= 0;
      return '<button type="button" class="my-chip' + (on ? " on" : "") + '" data-follow="' + a.key + '"' +
        (stars ? ' title="Following via your ★ favorites"' : "") + ">" +
        a.icon + " " + esc(a.name) +
        (stars ? ' <span class="n">★ ' + stars + "</span>" : "") + "</button>";
    }).join("") + "</div>";
  }

  function onboardingHtml(user) {
    return '<div class="my-sides" style="margin-bottom:14px">' +
      '<div class="card"><div class="my-side-ic">' +
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="var(--link)" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + IC.scores + '"/></svg></div><h2>The scoreboards</h2>' +
      '<p class="setnote" style="margin-bottom:8px">DCI and WGI, free — live scores, standings and ' +
      "history. Star the groups you care about and this page turns into your season: their next shows, " +
      "latest scores and ranking moves, together.</p>" +
      '<a class="tab" href="./">Browse the scoreboards →</a></div>' +
      '<div class="card" style="border-left:4px solid var(--priv)"><div class="my-side-ic">' +
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="var(--link)" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + IC.space + '"/></svg></div><h2>Your workspace</h2>' +
      '<p class="setnote" style="margin-bottom:8px">Cadence Ensemble is the private side — your organization\'s ' +
      "announcements, calendar, files and members, visible only to your group. Marching in an ensemble, " +
      "or running one? That lives here too.</p>" +
      '<a class="tab" href="ensemble/">Create or join a workspace →</a></div>' +
      "</div>" +
      card("Which circuits do you follow?",
        "tap to follow — starring favorites in an app follows it automatically",
        chipsHtml() +
        '<p class="setnote" style="margin:12px 0 0">Following a circuit shows its upcoming shows here. ' +
        "For the full experience, open the app and ★ your groups.</p>") +
      (user ? "" : '<div class="card" style="margin-top:14px"><h2>One account for all of it</h2>' +
        '<p class="setnote">Sign in and your favorites follow you to every device — and your ensemble ' +
        "workspaces appear right on this page.</p>" + signInFormHtml("myOb") + "</div>");
  }

  function signInFormHtml(idp) {
    if (!window.CadAccount || !CadAccount.enabled) {
      return '<p class="setnote">Sign-in isn\'t configured in this build — favorites still work on this device.</p>';
    }
    return '<form class="acct-form" data-signin="1" id="' + idp + 'Form">' +
      '<input class="ctrl" type="email" id="' + idp + 'Email" placeholder="you@example.com" autocomplete="email" required>' +
      '<button class="tab" type="submit">Email me a sign-in link</button></form>' +
      '<p class="acct-msg" id="' + idp + 'Msg" role="status"></p>';
  }
  function wireSignIn(root) {
    var forms = root.querySelectorAll("form[data-signin]");
    Array.prototype.forEach.call(forms, function (f) {
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        var msg = document.getElementById(f.id.replace(/Form$/, "Msg"));
        var email = document.getElementById(f.id.replace(/Form$/, "Email"));
        if (msg) { msg.className = "acct-msg"; msg.textContent = "Sending…"; }
        CadAccount.signIn(email ? email.value : "").then(function () {
          if (msg) { msg.className = "acct-msg ok"; msg.textContent = "Link sent — open it on this device to finish signing in."; }
        }).catch(function (err) {
          if (msg) { msg.className = "acct-msg err"; msg.textContent = "Couldn't send that link" + (err && err.message ? " — " + err.message : "") + "."; }
        });
      });
    });
  }

  /* ── hero ────────────────────────────────────────────────────────────── */
  function greeting() {
    var h = new Date().getHours();
    return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  }
  function heroHtml(stats) {
    var d = new Date();
    var dateLine = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    return '<section class="my-hero">' +
      '<div class="my-kicker">My Cadence · ' + esc(dateLine) + "</div>" +
      '<h1 class="my-title">' + greeting() + ".</h1>" +
      '<p class="my-sub">Your whole marching world on one page — the groups you follow across every ' +
      "scoreboard, and your own ensembles on the private side.</p>" +
      '<div class="my-stats">' +
      '<div class="my-stat"><div class="b"></div><div class="v">' + stats.favs + '</div><div class="l">Favorites</div></div>' +
      '<div class="my-stat"><div class="b"></div><div class="v">' + stats.circuits + '</div><div class="l">Circuits</div></div>' +
      '<div class="my-stat"><div class="b"></div><div class="v" id="myStatShows">–</div><div class="l">Shows ahead</div></div>' +
      '<div class="my-stat pv"><div class="b"></div><div class="v" id="myStatOrgs">–</div><div class="l">Workspaces</div></div>' +
      "</div></section>";
  }

  /* ── private half: lightweight PostgREST reader (works without CadOrg) ── */
  function sbToken() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!/^sb-.*-auth-token$/.test(k)) continue;
        var v = JSON.parse(localStorage.getItem(k));
        if (v && v.access_token) return v.access_token;
      }
    } catch (e) {}
    return null;
  }
  function sbRest(path) { // silent: any failure (no tables yet, RLS, offline) → null
    var cfg = window.CAD_SUPABASE;
    var t = sbToken();
    if (!cfg || !t) return Promise.resolve(null);
    return fetch(cfg.url + "/rest/v1/" + path, {
      headers: { apikey: cfg.publishableKey, Authorization: "Bearer " + t },
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function loadPrivate() {
    if (!window.CAD_SUPABASE || !sbToken()) return Promise.resolve(null); // signed out
    return sbRest("org_members?select=id,section,org:organizations(id,name,slug,plan,status,trial_ends_at)," +
      "role:org_roles(name)&status=eq.active&order=joined_at.asc").then(function (rows) {
      var mine = (rows || []).filter(function (r) { return r && r.org; }).slice(0, 4);
      if (!mine.length) return { orgs: [] };
      var nowIso = new Date().toISOString();
      var soonIso = new Date(Date.now() + 21 * 86400000).toISOString();
      return Promise.all(mine.map(function (m) {
        return Promise.all([
          sbRest("org_events?select=id,title,kind,starts_at,location,rsvp_required&org_id=eq." + encodeURIComponent(m.org.id) +
            "&starts_at=gte." + nowIso + "&starts_at=lte." + soonIso + "&order=starts_at.asc&limit=6"),
          sbRest("posts?select=id,title,body,priority,pinned,requires_ack,created_at&org_id=eq." + encodeURIComponent(m.org.id) +
            "&archived=is.false&order=pinned.desc,created_at.desc&limit=5"),
          sbRest("org_event_rsvps?select=event_id&member_id=eq." + encodeURIComponent(m.id)),
          sbRest("post_acks?select=post_id&member_id=eq." + encodeURIComponent(m.id)),
        ]).then(function (r) {
          return { m: m, events: r[0] || [], posts: r[1] || [], rsvps: r[2] || [], acks: r[3] || [] };
        });
      })).then(function (workspaces) { return { orgs: workspaces }; });
    });
  }

  function privWhen(iso) {
    var d = new Date(iso), n = new Date();
    var today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    if (today) {
      var t = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      return "<b>Today</b><small>" + esc(t) + "</small>";
    }
    return "<b>" + MONTHS[d.getMonth()] + " " + d.getDate() + "</b><small>" +
      esc(d.toLocaleDateString(undefined, { weekday: "short" })) + "</small>";
  }
  function orgBadge(org) { return '<span class="privbadge"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px"><path d="M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3"/></svg> ' + esc(org.name) + "</span>"; }

  function privateHtml(data, user) {
    var head = '<div class="secdiv my-priv-div"><span class="lock"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3"/></svg></span> Your workspaces · private</div>';
    if (!data) { // signed out — the private half still exists, honestly
      return '<div class="my-priv">' + head +
        '<div class="my-grid"><div class="card"><h2>Sign in to see your workspaces</h2>' +
        '<p class="setnote">Rehearsal schedules, announcements and everything your organization runs on ' +
        "Cadence Ensemble shows up here — visible only to you.</p>" + signInFormHtml("myPv") + "</div>" +
        inviteCardHtml() + "</div></div>";
    }
    if (!data.orgs.length) { // signed in, no workspace yet — a first-class invitation
      return '<div class="my-priv">' + head + '<div class="my-grid">' + inviteCardHtml() +
        '<div class="card"><h2>Already in an organization?</h2>' +
        '<p class="setnote">If your director set up Cadence Ensemble, ask them for an invite code — ' +
        "members join free, and the workspace appears right here.</p>" +
        '<a class="tab" href="ensemble/">Enter your invite code →</a></div>' +
        "</div></div>";
    }

    // aggregate: what's waiting on this person, across every workspace
    var needs = [];
    data.orgs.forEach(function (w) {
      var rsvped = {}, acked = {};
      w.rsvps.forEach(function (r) { rsvped[r.event_id] = true; });
      w.acks.forEach(function (a2) { acked[a2.post_id] = true; });
      w.events.forEach(function (e) {
        if (e.rsvp_required && !rsvped[e.id]) {
          needs.push('<a class="my-item my-need" href="ensemble/event.html?id=' + encodeURIComponent(e.id) + '">' +
            '<span class="my-when"><b>RSVP</b></span><span class="my-main"><b>' + esc(e.title) + "</b>" +
            '<span class="sub">needs your response</span></span>' + orgBadge(w.m.org) + "</a>");
        }
      });
      w.posts.forEach(function (p) {
        if (p.requires_ack && !acked[p.id]) {
          needs.push('<a class="my-item my-need" href="ensemble/feed.html#post-' + encodeURIComponent(p.id) + '">' +
            '<span class="my-when"><b>Read</b></span><span class="my-main"><b>' + esc(p.title || "Announcement") + "</b>" +
            '<span class="sub">acknowledgment required</span></span>' + orgBadge(w.m.org) + "</a>");
        }
      });
    });

    var events = [];
    data.orgs.forEach(function (w) {
      w.events.forEach(function (e) { events.push({ w: w, e: e }); });
    });
    events.sort(function (a, b) { return a.e.starts_at < b.e.starts_at ? -1 : 1; });
    var eventsBody = events.length ? events.slice(0, 7).map(function (x) {
      return '<a class="my-item" href="ensemble/event.html?id=' + encodeURIComponent(x.e.id) + '">' +
        '<span class="my-when">' + privWhen(x.e.starts_at) + "</span>" +
        '<span class="my-main"><b>' + esc(x.e.title) + "</b>" +
        (x.e.location ? '<span class="sub">' + esc(x.e.location) + "</span>" : "") + "</span>" +
        orgBadge(x.w.m.org) + "</a>";
    }).join("") : emptyRow("Nothing on the calendar in the next three weeks.");

    var posts = [];
    data.orgs.forEach(function (w) {
      w.posts.forEach(function (p) { posts.push({ w: w, p: p }); });
    });
    posts.sort(function (a, b) { return a.p.created_at < b.p.created_at ? 1 : -1; });
    var postsBody = posts.length ? posts.slice(0, 6).map(function (x) {
      var p = x.p;
      var tag = p.requires_ack ? '<span class="ens-tag urgent" style="background:var(--priv-wash);color:var(--priv)">Ack</span>'
        : p.priority === "urgent" ? '<span class="ens-tag urgent">Urgent</span>'
        : p.priority === "important" || p.pinned ? '<span class="ens-tag important">Pinned</span>' : "";
      return '<a class="my-item" href="ensemble/feed.html#post-' + encodeURIComponent(p.id) + '">' +
        '<span class="my-main"><b>' + esc(p.title || "Announcement") + " " + tag + "</b>" +
        '<span class="sub">' + esc(String(p.body || "").slice(0, 90)) + "</span></span>" +
        orgBadge(x.w.m.org) + "</a>";
    }).join("") : emptyRow("No announcements yet.");

    var wsChips = '<div class="my-chips">' + data.orgs.map(function (w) {
      return '<a class="my-chip on" style="border-color:var(--priv);background:var(--priv-wash);color:var(--priv);text-decoration:none" ' +
        'href="ensemble/home.html?org=' + encodeURIComponent(w.m.org.id) + '">' + sic(IC.space) + " " + esc(w.m.org.name) +
        ' <span class="n" style="color:var(--priv)">' + esc((w.m.role && w.m.role.name) || "Member") + "</span></a>";
    }).join("") + "</div>";

    return '<div class="my-priv">' + head + '<div class="my-grid">' +
      (needs.length ? card("Waiting on you", null, needs.join("")) : "") +
      card("Rehearsals &amp; events", null, eventsBody) +
      card("Announcements", null, postsBody) +
      card("Your workspaces", null, wsChips +
        '<p class="privline" style="margin-top:12px">Private to your organizations — none of this ever appears on the public scoreboards.</p>') +
      "</div></div>";
  }

  function inviteCardHtml() {
    return '<div class="card"><div class="my-invite"><span class="ic" style="color:var(--priv)">' +
      '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h7v12H4zM13 6h7v7h-7zM13 17h7"/></svg></span><div>' +
      "<h2>Run your ensemble on Cadence</h2>" +
      '<p class="setnote" style="margin:4px 0 0">A private workspace for your organization — announcements, ' +
      "calendar with RSVPs, files and members, in the same app your fans already use.</p>" +
      '<div class="facts"><span><b>60-day free trial</b> · everything unlocked</span>' +
      "<span><b>One plan per organization</b> · members join free</span></div>" +
      '<div style="margin-top:12px"><a class="tab" href="ensemble/">Start a workspace →</a></div>' +
      "</div></div></div>";
  }

  /* ── page assembly ───────────────────────────────────────────────────── */
  var lastUid = "__unset__";

  function render() {
    var active = APPS.filter(isActive);
    var totalFavs = 0;
    APPS.forEach(function (a) { totalFavs += favsOf(a).length; });
    var user = window.CadAccount && CadAccount.user && CadAccount.user();

    var html = heroHtml({ favs: totalFavs, circuits: active.length });

    if (!active.length) {
      // fresh visitor: explain both sides, never a dead end
      html += '<div class="secdiv">Welcome to Cadence</div>' + onboardingHtml(user);
      html += '<div id="myPrivHost"></div>';
      app.innerHTML = html + tipHtml();
      wireChips(); wireSignIn(app);
      mountPrivate();
      updated("");
      return;
    }

    html += '<div class="secdiv">Scoreboards · public</div>' +
      '<div id="myPubHost"><div class="loading">Checking your circuits…</div></div>' +
      '<div id="myPrivHost"></div>';
    app.innerHTML = html + tipHtml();
    wireSignIn(app);
    mountPrivate();

    Promise.all(active.map(appData)).then(function (datas) {
      var got = collect(datas);
      var host = document.getElementById("myPubHost");
      if (!host) return;
      host.innerHTML = '<div class="my-grid">' +
        card("Next up", "shows featuring your favorites", nextUpHtml(got.nextUp)) +
        card("Recent results", "latest scores for your ★", resultsHtml(got.results)) +
        card("Ranking movers", "biggest recent moves", moversHtml(got.movers)) +
        card("Your ensembles", "jump to a profile", favGroupsHtml(got.favGroups) +
          '<div class="secdiv" style="margin:14px 0 10px">Circuits you follow</div>' + chipsHtml()) +
        "</div>";
      wireChips();
      var el = document.getElementById("myStatShows");
      if (el) el.textContent = String(got.nextUp.length);
      var stamps = datas.map(function (d) { return d.rk && d.rk.generated; })
        .filter(function (s) { return /^\d{4}-/.test(s || ""); });
      updated(stamps.length ? "Scores as of " + stamps.sort().pop() : "");
    });
  }

  function tipHtml() {
    return '<p class="my-foot-tip">Tip: tap the Cadence logo up top to jump into any app — ' +
      "★ favorites you star there show up here automatically.</p>";
  }
  function updated(txt) {
    var el = document.getElementById("updated");
    if (el) el.textContent = txt || "";
  }

  function wireChips() {
    var chips = app.querySelectorAll("[data-follow]");
    Array.prototype.forEach.call(chips, function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-follow");
        var a = null;
        APPS.forEach(function (x) { if (x.key === key) a = x; });
        if (!a) return;
        var fl = followed();
        var i = fl.indexOf(key);
        if (i >= 0) fl.splice(i, 1);
        else fl.push(key);
        // a circuit followed via stars can't be un-followed here — clear stars in its app
        if (i >= 0 && favsOf(a).length) { setFollowed(fl); render(); return; }
        setFollowed(fl);
        render(); // data is session-cached — a re-render is cheap
      });
    });
  }

  function mountPrivate() {
    var host = document.getElementById("myPrivHost");
    if (!host) return;
    var user = window.CadAccount && CadAccount.user && CadAccount.user();
    if (!user && !sbToken()) { // plainly signed out
      host.innerHTML = privateHtml(null, null);
      wireSignIn(host);
      var so = document.getElementById("myStatOrgs");
      if (so) so.textContent = "0";
      return;
    }
    loadPrivate().then(function (data) {
      var h = document.getElementById("myPrivHost");
      if (!h) return;
      h.innerHTML = privateHtml(data || { orgs: [] }, user);
      wireSignIn(h);
      var so = document.getElementById("myStatOrgs");
      if (so) so.textContent = String(data && data.orgs ? data.orgs.length : 0);
    });
  }

  /* first paint now; re-run the private half when the session settles or the
     user signs in/out (account.js emits on every auth change) */
  render();
  if (window.CadAccount && CadAccount.onChange) {
    CadAccount.onChange(function () {
      var u = CadAccount.user();
      var uid = u ? u.id : null;
      if (uid === lastUid) return;
      lastUid = uid;
      mountPrivate();
    });
  }
})();
