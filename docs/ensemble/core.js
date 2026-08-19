/* Cadence Ensemble — shared runtime for the private organization side.
   Loaded by every page under /ensemble/ after supabase.js + account.js.

   Owns: the Supabase REST helper (reusing the session account.js persists),
   the current-organization context, permission checks, plan entitlements,
   the shared app shell so every Ensemble screen is unmistakably Cadence,
   and the in-app notification reader (the bell) that drains what
   0014_notifications.sql queues for the signed-in member.

   Nothing here trusts the browser: every check mirrored below is also
   enforced by RLS in supabase/migrations/0005_ensemble_core.sql. The UI
   checks exist to avoid showing people buttons that would fail. */
(function () {
  "use strict";
  var cfg = window.CAD_SUPABASE;
  if (!cfg) return;

  /* ── plans & entitlements ─────────────────────────────────────────────
     One place decides what a plan includes. Never scatter plan checks
     through screens — call CadOrg.canUseFeature(org, "attendance"). */
  var GB = 1073741824;
  var PLANS = {
    trial: {
      label: "Trial", price: null, storage: 5 * GB, memberLimit: 20,
      features: "*", // a trial is the full product, on purpose
    },
    ensemble: {
      label: "Cadence Ensemble", price: 149, storage: 10 * GB, memberLimit: null,
      features: ["announcements", "groups", "chat", "calendar", "rsvp",
                 "attendance", "forms", "parents", "files", "music_library",
                 "competition_link", "signups", "tasks", "polls"],
    },
    pro: {
      label: "Cadence Ensemble Pro", price: 299, storage: 25 * GB, memberLimit: null,
      features: "*",
    },
    program: {
      label: "Cadence Program", price: 499, storage: 100 * GB, memberLimit: null,
      features: "*", ensembles: 5,
    },
    none: { label: "No plan", price: null, storage: 1 * GB, memberLimit: null, features: [] },
  };
  // features only the full plans carry (everything else is in every paid plan)
  var PRO_FEATURES = ["staff_workspace", "itineraries", "packing_lists",
    "assignments", "submissions", "equipment", "uniforms", "auditions",
    "advanced_permissions", "advanced_reporting", "acknowledgments",
    "volunteer_management", "automation"];

  /* statuses that still allow creating content — mirrors org_writable() */
  var WRITABLE = ["active", "past_due", "invoice_pending", "grace_period"];

  function planOf(org) { return PLANS[org && org.plan] || PLANS.none; }

  function trialDaysLeft(org) {
    if (!org || !org.trial_ends_at) return null;
    var ms = new Date(org.trial_ends_at) - new Date();
    return ms <= 0 ? 0 : Math.ceil(ms / 86400000);
  }

  function isWritable(org) {
    if (!org) return false;
    if (org.status === "trialing") return trialDaysLeft(org) > 0;
    return WRITABLE.indexOf(org.status) >= 0;
  }

  function canUseFeature(org, feature) {
    if (!org) return false;
    var p = planOf(org);
    if (p.features === "*") return true;
    if (p.features.indexOf(feature) >= 0) return true;
    return false; // PRO_FEATURES fall through here for the base plan
  }

  /* ── REST helper: PostgREST with the signed-in user's token, so every
     request is evaluated under that user's RLS policies. ──────────────── */
  function token() {
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

  async function rest(path, opts) {
    opts = opts || {};
    var t = token();
    var headers = Object.assign({
      apikey: cfg.publishableKey,
      "Content-Type": "application/json",
    }, opts.headers || {});
    if (t) headers.Authorization = "Bearer " + t;
    var res = await fetch(cfg.url + "/rest/v1/" + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var text = await res.text();
    var json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      var err = new Error((json && (json.message || json.hint)) || ("request failed " + res.status));
      err.status = res.status; err.body = json;
      throw err;
    }
    return json;
  }

  async function rpc(fn, args) {
    return rest("rpc/" + fn, { method: "POST", body: args || {} });
  }

  /* ── organization context ─────────────────────────────────────────── */
  var CUR_KEY = "cad-org-current";
  var state = { orgs: null, org: null, member: null, role: null, perms: [] };

  async function loadOrgs() {
    // one round trip: my member rows with their org and role expanded
    var rows = await rest("org_members?select=id,role_id,section,instrument," +
      "leadership_title,status,display_name,org:organizations(*),role:org_roles!org_members_role_id_fkey(*)" +
      "&status=eq.active&order=joined_at.asc");
    state.orgs = (rows || []).filter(function (r) { return r.org; });
    return state.orgs;
  }

  function pick(orgId) {
    var row = (state.orgs || []).filter(function (r) {
      return r.org && (r.org.id === orgId || r.org.slug === orgId);
    })[0] || (state.orgs || [])[0] || null;
    state.member = row || null;
    state.org = row ? row.org : null;
    state.role = row ? row.role : null;
    state.perms = row && row.role ? (row.role.permissions || []) : [];
    if (state.org) { try { localStorage.setItem(CUR_KEY, state.org.id); } catch (e) {} }
    return state.org;
  }

  function can(perm) {
    return state.perms.indexOf("org.admin") >= 0 || state.perms.indexOf(perm) >= 0;
  }
  /* the check screens should actually use: permission AND plan AND status */
  function canDo(perm, feature) {
    if (!can(perm)) return false;
    if (!isWritable(state.org)) return false;
    if (feature && !canUseFeature(state.org, feature)) return false;
    return true;
  }

  async function log(action, targetType, targetId, detail) {
    if (!state.org) return;
    try {
      await rest("org_audit_log", { method: "POST", body: {
        org_id: state.org.id, action: action, target_type: targetType || null,
        target_id: targetId ? String(targetId) : null, detail: detail || {},
      } });
    } catch (e) {}
  }

  /* ── shared shell ─────────────────────────────────────────────────────
     Same topbar/nav language as public Cadence, tuned for operations:
     a workspace switcher in place of the app switcher, and a section nav
     that becomes a bottom bar on phones. */
  /* Tabs, done properly. The workspace list is the front door; once you are
     inside a group, its sections live in one modern rail under the top bar —
     horizontally scrollable on phones, always showing where you are. */
  /* Nine equal destinations don't fit a phone. The four a member reaches
     for daily (plus More) make the dock; everything else lives one tap away
     in the More sheet. Desktop has the room, so it keeps the full rail —
     `sec: true` marks the sections that fold into More on phones. */
  /* Icons share the public app's dock language: 24-grid, stroke 2, round
     caps, rounded rectangles, no fussy detail — they read at 26px. */
  var SECTIONS = {
    home:      { label: "Home", href: "home.html",
                 ico: "M4 11.5 12 4.5l8 7M6.5 10.5V18a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-7.5" },
    feed:      { label: "Announcements", href: "feed.html", sec: true,
                 ico: "M4 10v4h3l7 4.5v-13L7 10H4zM17.5 9.5a4 4 0 0 1 0 5" },
    calendar:  { label: "Calendar", href: "calendar.html",
                 ico: "M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 10h16M9 3v4M15 3v4" },
    messages:  { label: "Messages", href: "messages.html",
                 ico: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8L5 20z" },
    files:     { label: "Files", href: "files.html", sec: true,
                 ico: "M3.5 8a2 2 0 0 1 2-2h3.6l1.8 2h7.6a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" },
    music:     { label: "Music", href: "music.html", sec: true,
                 ico: "M9.5 17.5V6l9-1.8V15M9.5 17.5a2.4 2.4 0 1 1-4.8 0 2.4 2.4 0 0 1 4.8 0zm9-2.5a2.4 2.4 0 1 1-4.8 0 2.4 2.4 0 0 1 4.8 0z" },
    drill:     { label: "Drill", href: "drill.html",
                 ico: "M3.5 7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM12 5v14M8 10h.01M16 12h.01M9.5 14.5h.01" },
    forms:     { label: "Forms", href: "forms.html", sec: true,
                 ico: "M6 5a1.5 1.5 0 0 1 1.5-1.5H14L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19zM14 3.5V8h4M9.5 12.5h5M9.5 16h5" },
    members:   { label: "Members", href: "members.html", sec: true,
                 ico: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.8 19.5c.4-3 2.7-4.8 5.2-4.8s4.8 1.8 5.2 4.8M16 11a2.6 2.6 0 1 0-1.2-4.9M16.6 14.9c2 .3 3.5 1.9 3.9 4.1" },
    admin:     { label: "Admin", href: "admin.html", sec: true,
                 ico: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 3v2.5M12 18.5V21M21 12h-2.5M5.5 12H3M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8M18.4 18.4l-1.8-1.8M7.4 7.4 5.6 5.6" },
    // subpages highlight their parent tab
    billing:   { parent: "admin", label: "Billing", href: "billing.html" },
    event:     { parent: "calendar", label: "Event", href: "event.html" },
  };

  function sectionVisible(k) {
    if (k === "admin") return can("org.admin") || can("member.manage");
    return true;
  }

  /* The workspace LIST is not "inside" any workspace, so it wears the
     public app's own topbar — Scoreboard, Shows, Corps, Stats, and the lit
     Workspace tab — exactly as the main app renders them. Section tabs and
     the org picker appear only once you've entered a specific workspace. */
  function listShellHtml() {
    function icon(d) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
    }
    return '' +
      '<header class="topbar">' +
        '<a class="brand" href="../">' +
          '<svg viewBox="0 0 64 64" width="30" height="30" aria-hidden="true">' +
          '<rect x="3" y="3" width="58" height="58" rx="15" fill="#f0b429"/>' +
          '<g stroke="#16233d" stroke-width="6.5" stroke-linecap="round">' +
          '<line x1="16" y1="26" x2="16" y2="38"/><line x1="27" y1="20" x2="27" y2="44"/>' +
          '<line x1="38" y1="28" x2="38" y2="36"/><line x1="49" y1="16" x2="49" y2="48"/></g></svg>' +
          "<span>Cadence</span></a>" +
        '<nav id="nav">' +
          '<a href="../#/">' + icon("M5 20V12M12 20V5M19 20v-6M3 20h18") + "<span>Scoreboard</span></a>" +
          '<a href="../#/events">' + icon("M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 10h16M9 3v4M15 3v4") + "<span>Shows</span></a>" +
          '<a href="../#/corps">' + icon("M7 5l10 4M17 5L7 9M6 9h12a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2zM4 12.5h16") + "<span>Corps</span></a>" +
          '<a href="../#/stats">' + icon("M5 6c0-1.66 3.13-3 7-3s7 1.34 7 3-3.13 3-7 3-7-1.34-7-3zM5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3") + "<span>Stats</span></a>" +
          '<a href="./" class="navmy active" aria-current="page">' + icon("M4 6h7v12H4zM13 6h7v7h-7zM13 17h7") + "<span>Workspace</span></a>" +
        "</nav>" +
      "</header>";
  }

  function shellHtml(active) {
    if (active === "list") return listShellHtml();
    var org = state.org;
    var sec = SECTIONS[active] || SECTIONS.home;
    var lit = sec.parent || (SECTIONS[active] ? active : "home");
    var moreLit = !!(SECTIONS[lit] && SECTIONS[lit].sec);   // active page lives in More
    var tabs = "";
    if (org) {
      tabs = Object.keys(SECTIONS).map(function (k) {
        var s = SECTIONS[k];
        if (s.parent) return "";                       // subpages don't get tabs
        if (!sectionVisible(k)) return "";
        return '<a class="ens-tab' + (s.sec ? " sec" : "") + (k === lit ? " on" : "") +
          '" href="' + s.href + '"' +
          (k === lit ? ' aria-current="page"' : "") + ">" +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + s.ico + '"/></svg>' +
          "<span>" + s.label + "</span></a>";
      }).join("");
      // phones: the folded sections live one tap away behind More
      tabs += '<button class="ens-tab ens-more' + (moreLit ? " on" : "") + '" type="button" ' +
        'id="ensMoreBtn" aria-haspopup="dialog" aria-label="More sections">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M6.5 4.5h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2zM15.5 4.5h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2zM6.5 13.5h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2zM15.5 13.5h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2z"/></svg>' +
        "<span>More</span></button>";
    }
    return '' +
      '<header class="topbar ens-top">' +
        '<a class="brand" href="../" title="Cadence scoreboards">' +
          '<svg viewBox="0 0 64 64" width="28" height="28" aria-hidden="true">' +
          '<rect x="3" y="3" width="58" height="58" rx="15" fill="#339af0"/>' +
          '<g stroke="#ffd43b" stroke-width="6.5" stroke-linecap="round">' +
          '<line x1="16" y1="26" x2="16" y2="38"/><line x1="27" y1="20" x2="27" y2="44"/>' +
          '<line x1="38" y1="28" x2="38" y2="36"/><line x1="49" y1="16" x2="49" y2="48"/></g></svg>' +
          "<span>Cadence</span></a>" +
        (org ? '<button class="ens-orgpick" id="ensOrgPick" type="button">' +
          "<b>" + esc(org.name) + "</b><span class=\"ens-caret\">▾</span></button>" : "") +
        (org ? '<button class="ens-bell" id="ensBell" type="button" ' +
          'aria-haspopup="dialog" aria-label="Notifications">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18.5h15z"/><path d="M10 21h4"/></svg>' +
          '<span class="ens-bell-n" id="ensBellN" hidden></span></button>' : "") +
      "</header>" +
      (tabs ? '<nav class="ens-tabs" aria-label="Workspace sections">' + tabs + "</nav>" : "") +
      (org ? statusStripHtml(org) : "");
  }

  function statusStripHtml(org) {
    if (org.status === "trialing") {
      var d = trialDaysLeft(org);
      return '<div class="ens-strip' + (d <= 7 ? " warn" : "") + '">' +
        "<b>Cadence Ensemble Trial</b> · " + (d > 0 ? d + " day" + (d === 1 ? "" : "s") + " remaining" : "expired") +
        ' <a href="billing.html">See plans →</a></div>';
    }
    if (!isWritable(org)) {
      return '<div class="ens-strip warn"><b>Workspace is read-only.</b> ' +
        "Everything is preserved — upgrade to reactivate posting, messaging, uploads and attendance. " +
        '<a href="billing.html">Reactivate →</a></div>';
    }
    if (org.status === "past_due" || org.status === "grace_period") {
      return '<div class="ens-strip warn"><b>Payment needs attention.</b> ' +
        'Your workspace keeps working during the grace period. <a href="billing.html">Update billing →</a></div>';
    }
    return "";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function mountShell(active) {
    var host = document.getElementById("ensShell");
    if (!host) return;
    host.innerHTML = shellHtml(active);
    var pick = document.getElementById("ensOrgPick");
    if (pick) pick.addEventListener("click", function () { openSwitcher(); });
    var more = document.getElementById("ensMoreBtn");
    if (more) more.addEventListener("click", function () { openMoreSheet(active); });
    var bell = document.getElementById("ensBell");
    if (bell) {
      notifCss();
      bell.addEventListener("click", function () { openNotifSheet(); });
      paintBell();
      loadNotifs();   // the badge is a background fact — never gate the page on it
    }
  }

  /* keyboard accessibility for every sheet: focus moves in, Tab cycles
     inside, Escape closes, and focus returns to whatever opened it */
  function trapSheet(wrap, onClose) {
    var opener = document.activeElement;
    function focusables() {
      return [].slice.call(wrap.querySelectorAll(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'));
    }
    function close() {
      wrap.remove();
      document.removeEventListener("keydown", onKey, true);
      if (opener && opener.focus) { try { opener.focus(); } catch (e) {} }
      if (onClose) onClose();
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey, true);
    var f = focusables();
    if (f.length) setTimeout(function () { f[0].focus(); }, 0);
    return close;
  }

  // the phone dock's fifth tab: everything that folded out of the dock,
  // one tap away, in the same sheet language as the workspace switcher.
  // A thumb's reach is the bottom of the screen, not the top bar, so how
  // much this workspace may interrupt you is settable from down here too.
  function openMoreSheet(active) {
    var sec = SECTIONS[active] || SECTIONS.home;
    var lit = sec.parent || active;
    var wrap = document.createElement("div");
    wrap.className = "ens-sheet";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-label", "More sections");
    wrap.innerHTML = '<div class="ens-sheet-in"><h3>More</h3>' +
      Object.keys(SECTIONS).map(function (k) {
        var s = SECTIONS[k];
        if (s.parent || !s.sec || !sectionVisible(k)) return "";
        return '<a class="ens-sheet-row' + (k === lit ? " on" : "") + '" href="' + s.href + '">' +
          '<b style="display:inline-flex;align-items:center;gap:9px">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="' + s.ico + '"/></svg>' + s.label + "</b></a>";
      }).join("") +
      (can("billing.manage") || can("org.admin")
        ? '<a class="ens-sheet-row" href="billing.html"><b>Plan &amp; billing</b></a>' : "") +
      '<button class="ens-sheet-row" id="ensMorePrefs" type="button">' +
      "<b>Notification settings</b></button>" +
      '<button class="tab" id="ensMoreClose" type="button" style="margin-top:12px">Close</button></div>';
    document.body.appendChild(wrap);
    var close = trapSheet(wrap);
    wrap.addEventListener("click", function (e) {
      var prefs = e.target.closest && e.target.closest("#ensMorePrefs");
      if (prefs) { close(); openPrefsSheet(); return; }
      if (e.target === wrap || e.target.id === "ensMoreClose") close();
    });
  }

  function openSwitcher() {
    var wrap = document.createElement("div");
    wrap.className = "ens-sheet";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-label", "Your workspaces");
    wrap.innerHTML = '<div class="ens-sheet-in"><h3>Your workspaces</h3>' +
      (state.orgs || []).map(function (r) {
        return '<button class="ens-sheet-row' + (state.org && r.org.id === state.org.id ? " on" : "") +
          '" data-id="' + r.org.id + '"><b>' + esc(r.org.name) + "</b>" +
          '<span>' + esc((r.role && r.role.name) || "Member") + "</span></button>";
      }).join("") +
      '<a class="ens-sheet-row" href="index.html"><b>All workspaces</b>' +
        "<span>Back to the list — join or start another</span></a>" +
      '<button class="tab" id="ensSheetClose" type="button" style="margin-top:12px">Close</button></div>';
    document.body.appendChild(wrap);
    var close = trapSheet(wrap);
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || e.target.id === "ensSheetClose") { close(); return; }
      var row = e.target.closest && e.target.closest("[data-id]");
      if (row) { pick(row.dataset.id); location.reload(); }
    });
  }

  /* ── in-app notifications ─────────────────────────────────────────────
     0014_notifications.sql queues an 'inapp' row for every acknowledgment-
     required announcement and every RSVP-required event, and its RLS
     (notif_read_own for select, notif_mark_read for update) exists for
     exactly one reader: the recipient's own browser. This is that reader.

     The query carries NO user filter, on purpose. notif_read_own already
     restricts every visible row to
       channel = 'inapp' and recipient_member_id = org_member_id(org_id)
     so a client-side copy of that rule would be decoration, not security.
     org_id is in the query only so the bell talks about the workspace you
     are actually looking at. */
  var NOTIF_LIMIT = 30;
  /* unread, in-app, not withdrawn. Deliberately NOT `status = 'sent'`: the
     row is readable the moment the trigger enqueues it, so a deployment
     with no worker running still gets its notifications instead of an
     empty bell forever. */
  var NOTIF_FILTER = "channel=eq.inapp&read_at=is.null&status=neq.canceled";
  var notif = { count: 0, rows: null, err: false };

  function notifQuery(orgId, limit) {
    return "org_notifications?select=id,type,priority,payload,created_at&" +
      NOTIF_FILTER + "&org_id=eq." + orgId +
      "&order=created_at.desc&limit=" + (limit || NOTIF_LIMIT);
  }
  function notifAllPath(orgId) {      // the same set, addressed for one PATCH
    return "org_notifications?" + NOTIF_FILTER + "&org_id=eq." + orgId;
  }

  /* where push-server/notify-worker.js's render() sends each type, minus
     the origin — one link, whichever channel got there first */
  function notifLink(n) {
    var p = (n && n.payload) || {};
    if (n && n.type === "ack_post") return "feed.html#post-" + encodeURIComponent(p.post_id || "");
    if (n && n.type === "rsvp") return "event.html?id=" + encodeURIComponent(p.event_id || "");
    return "home.html";               // a type this build doesn't know yet
  }
  /* Is that link this very page? Only the fragment may differ: a different
     query string ("event.html?id=e2" from event.html?id=e1) is a real
     navigation, a different fragment is not. */
  function samePageAs(href) {
    var s = String(href == null ? "" : href);
    var cut = s.indexOf("#");
    var target = cut < 0 ? s : s.slice(0, cut);
    var here = String((location.pathname || "").split("/").pop() || "") +
               String(location.search || "");
    return !!target && target === here;
  }

  /* Follow a notification's link — including when it points at the page you
     are already on. "feed.html#post-x" tapped ON feed.html is a same-document
     fragment change: the browser fires no navigation, so nothing re-renders
     and the card never gets brought into view. feed.html reads the hash only
     from inside render(), and nothing under /ensemble/ listens for hashchange
     except admin.html — and the member an acknowledgment-required
     announcement is aimed at is exactly the person already on the feed. So
     put the fragment in place and reload: the page routes it on the way up. */
  function notifGo(href) {
    if (!samePageAs(href)) { location.href = href; return "assign"; }
    var cut = String(href).indexOf("#");
    if (cut >= 0 && location.hash !== href.slice(cut)) location.hash = href.slice(cut);
    location.reload();
    return "reload";
  }

  function notifLine(n) {
    if (n.type === "ack_post") return "Needs your acknowledgment";
    if (n.type === "rsvp") return "Please RSVP";
    return "Tap to open";
  }

  /* a compact relative time. comms.js has the richer one the feed uses; it
     isn't loaded on every screen, and the bell is. */
  function notifAgo(ts) {
    if (!ts) return "";
    var d = new Date(ts), s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    if (s < 604800) return Math.round(s / 86400) + "d ago";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  /* one place owns the number, and it floors at zero: a stale row, a double
     dismissal or a re-read must never paint "-1" on the bell */
  function setUnread(n) {
    var v = Math.floor(Number(n));
    notif.count = v > 0 ? v : 0;
    paintBell();
    return notif.count;
  }

  function paintBell() {
    var bell = document.getElementById("ensBell");
    if (!bell) return;
    var badge = document.getElementById("ensBellN");
    if (badge) {
      badge.hidden = notif.count === 0;
      badge.textContent = notif.count > 9 ? "9+" : String(notif.count);
    }
    bell.setAttribute("aria-label", notif.count
      ? "Notifications — " + notif.count + " unread" : "Notifications");
  }

  async function loadNotifs() {
    if (!state.org) { notif.rows = []; setUnread(0); return notif.rows; }
    try {
      notif.rows = (await rest(notifQuery(state.org.id, NOTIF_LIMIT))) || [];
      notif.err = false;
    } catch (e) {
      // queue table missing (migrations behind) or the network is out — say
      // nothing rather than paint a number we can't stand behind
      notif.err = true; notif.rows = [];
    }
    setUnread(notif.rows.length);
    return notif.rows;
  }

  /* read_at is the ONLY column a recipient may write — guard_notification_update()
     in 0014 raises 'notification_readonly' on anything else. Keep both bodies
     below exactly one key wide.

     The badge is reconciled against the list, never decremented blind: a row
     that was not on the list (a double tap, a sheet left open while another
     device read it, a row already dismissed) must not move the number, or
     three unread become one after two taps on the same notification. */
  async function markRead(id) {
    await rest("org_notifications?id=eq." + encodeURIComponent(id), {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: { read_at: new Date().toISOString() },
    });
    var rows = notif.rows;
    if (!rows) return notif.count;          // never loaded — nothing to reconcile with
    var kept = rows.filter(function (r) { return r.id !== id; });
    if (kept.length === rows.length) return notif.count;   // it was already off the list
    notif.rows = kept;
    return setUnread(kept.length);
  }

  async function markAllRead() {
    if (!state.org) return;
    await rest(notifAllPath(state.org.id), {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: { read_at: new Date().toISOString() },
    });
    notif.rows = [];
    setUnread(0);
  }

  function notifSheetHtml(note) {
    var rows = notif.rows || [];
    var body;
    if (notif.err) {
      body = '<div class="empty" style="padding:26px 8px">Couldn\'t reach your ' +
        "notifications just now.</div>";
    } else if (!rows.length) {
      body = '<div class="empty" style="padding:26px 8px">You\'re all caught up.</div>';
    } else {
      body = rows.map(function (n) {
        return '<a class="ens-sheet-row ens-notif" href="' + notifLink(n) +
          '" data-notif="' + esc(n.id) + '">' +
          "<b>" + esc((n.payload && n.payload.title) || "Cadence") + "</b>" +
          "<span>" + esc(notifLine(n)) +
          (n.priority === "urgent" ? " · Urgent" : "") +
          " · " + esc(notifAgo(n.created_at)) + "</span></a>";
      }).join("");
    }
    return '<div class="ens-sheet-in"><h3>Notifications</h3>' + body +
      '<p class="ens-prefmsg' + (note && note.bad ? " bad" : "") +
        '" id="ensNotifMsg" role="status">' + esc(note ? note.text : "") + "</p>" +
      '<div class="ens-notif-acts">' +
        (rows.length ? '<button class="tab" id="ensNotifAll" type="button">Mark all read</button>' : "") +
        '<button class="tab" id="ensNotifPrefs" type="button">Settings</button>' +
        '<button class="tab" id="ensNotifClose" type="button">Close</button>' +
      "</div></div>";
  }

  function openNotifSheet() {
    var wrap = document.createElement("div");
    wrap.className = "ens-sheet";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-label", "Notifications");
    wrap.innerHTML = '<div class="ens-sheet-in"><h3>Notifications</h3>' +
      '<div class="empty" style="padding:26px 8px">Loading…</div></div>';
    document.body.appendChild(wrap);
    var close = trapSheet(wrap);
    var note = null;
    function paint() {
      wrap.innerHTML = notifSheetHtml(note);
      var f = wrap.querySelector("a, button");
      if (f && document.activeElement === document.body) f.focus();
    }
    /* a sheet that redraws the same rows after a failed action looks like it
       ignored the tap — say what happened, the way settings does */
    function say(text, bad) { note = text ? { text: text, bad: !!bad } : null; paint(); }
    loadNotifs().then(paint, paint);
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || e.target.id === "ensNotifClose") { close(); return; }
      if (e.target.id === "ensNotifAll") {
        say("Marking all read…");
        markAllRead().then(function () { say(""); }, function () {
          say("Couldn't mark those read just now — they're all still here.", true);
        });
        return;
      }
      if (e.target.id === "ensNotifPrefs") { close(); openPrefsSheet(); return; }
      var row = e.target.closest && e.target.closest("[data-notif]");
      if (!row) return;
      e.preventDefault();
      var href = row.getAttribute("href");
      // dismiss first, but a failed PATCH must never strand someone on a
      // sheet — the deep link is the point of the notification. Take the
      // sheet down before following it: the row is spent either way, and
      // when the link is this very page there is no unload to remove it.
      function go() { close(); notifGo(href); }
      markRead(row.getAttribute("data-notif")).then(go, go);
    });
  }

  /* ── notification preferences ─────────────────────────────────────────
     org_notification_prefs (0006) is one row per member, scope, scope_id
     and channel. The CHECK constraints as 0006 shipped them:
       scope   in ('org', 'group', 'chat')
       channel in ('push', 'email')
       level   in ('all', 'important', 'urgent', 'none')
     This surface writes scope 'org' only — the workspace-wide switch the
     feed already promises members, and the exact row every enqueue path
     looks up: should_notify(member, 'org', org_id, channel, priority).
     Chats have their own mute (chat_members.muted, in messages.html);
     groups have no UI yet.

     0019 widens `channel` to include 'inapp' so the bell is mutable like
     any other channel. On a database still short of it the insert is
     refused, so that row is offered optimistically and folds away with a
     plain note — nobody should meet a raw exception over a column
     constraint they cannot see.

     Only channels something actually asks about are offered. 'email' is a
     legal value of the column and always has been, but no delivery path
     ever calls should_notify(..., 'email', ...): 0014 and 0019 ask about
     'inapp' and 'push', and the single email the workspace sends —
     notify_invite() — is addressed to a person who is not a member yet, so
     no per-member row could gate it even in principle. A control that
     changes nothing is a lie told politely, so email gets a sentence of
     explanation instead of a switch. Add the row back the day something
     consults it. Push is likewise honest about its reach: 0019's
     enqueue_event_notifications() queues RSVPs 'inapp' only, so the push
     level governs acknowledgment-required announcements alone. */
  var LEVELS = [
    ["all", "Everything"],
    ["important", "Important and urgent"],
    ["urgent", "Urgent only"],
    ["none", "Mute"],
  ];
  var CHANNELS = [
    ["inapp", "In the workspace",
     "The bell on every page — acknowledgment requests and RSVP requests."],
    ["push", "Push notifications",
     "Your phone and desktop. Acknowledgment-required announcements only; " +
     "RSVP requests are in-app."],
  ];
  /* what the workspace does about email, said once, where the row used to be */
  var EMAIL_NOTE = "Cadence sends members no email about announcements or " +
    "events, so there is nothing here to set for it. The one email the " +
    "workspace sends is the invitation to join it, and that goes out before " +
    "the person it reaches is a member with settings at all.";
  var prefsOff = {};   // channels this database refused, for this session

  async function loadPrefs() {
    // notif_own already narrows this to the caller's own member rows
    var rows = await rest("org_notification_prefs?select=channel,level" +
      "&scope=eq.org&scope_id=eq." + state.org.id);
    var cur = {};
    (rows || []).forEach(function (r) { cur[r.channel] = r.level; });
    return cur;
  }

  async function savePref(channel, level) {
    return rest("org_notification_prefs", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
      body: {
        member_id: state.member.id, scope: "org", scope_id: state.org.id,
        channel: channel, level: level,
      },
    });
  }

  /* a channel value this database's CHECK constraint won't accept is a fact
     about the schema, not something to throw at someone muting their phone */
  function channelRejected(err) {
    if (!err) return false;
    var b = err.body || {};
    if (b.code === "23514") return true;      // check_violation, whatever status carried it
    var msg = String(b.message || b.details || err.message || "");
    return err.status === 400 && /check constraint/i.test(msg);
  }

  function prefsSheetHtml(cur, failed) {
    var org = state.org;
    var rows = failed ? '<div class="empty" style="padding:26px 8px">Couldn\'t reach ' +
      "your notification settings just now.</div>"
      : CHANNELS.map(function (c) {
          if (prefsOff[c[0]]) return "";
          return '<label class="ens-prefrow"><span class="ens-preflab"><b>' + c[1] + "</b>" +
            '<span class="ens-prefhint">' + c[2] + "</span></span>" +
            '<select class="ctrl" data-ch="' + c[0] + '">' +
            LEVELS.map(function (l) {
              return '<option value="' + l[0] + '"' +
                ((cur[c[0]] || "all") === l[0] ? " selected" : "") + ">" + l[1] + "</option>";
            }).join("") + "</select></label>";
        }).join("");
    return '<div class="ens-sheet-in"><h3>Notifications from ' +
      esc(org ? org.name : "this workspace") + "</h3>" +
      '<p class="setnote" style="margin:0 0 10px">Choose how much this workspace ' +
      "may interrupt you. Urgent announcements always get through — that is the " +
      "one rule the workspace will not bend.</p>" + rows +
      (failed ? "" : '<p class="ens-prefhint" style="margin:10px 2px 0">' +
        EMAIL_NOTE + "</p>") +
      '<p class="ens-prefmsg" id="ensPrefMsg" role="status"></p>' +
      '<div class="ens-notif-acts">' +
        (failed ? "" : '<button class="tab" id="ensPrefMute" type="button">Mute this workspace</button>') +
        '<button class="tab" id="ensPrefClose" type="button">Close</button>' +
      "</div></div>";
  }

  function openPrefsSheet() {
    if (!state.org || !state.member) return;
    var wrap = document.createElement("div");
    wrap.className = "ens-sheet";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-label", "Notification settings");
    wrap.innerHTML = '<div class="ens-sheet-in"><h3>Notification settings</h3>' +
      '<div class="empty" style="padding:26px 8px">Loading…</div></div>';
    document.body.appendChild(wrap);
    notifCss();
    var close = trapSheet(wrap);
    var cur = {}, failed = false;

    function paint() {
      wrap.innerHTML = prefsSheetHtml(cur, failed);
      var f = wrap.querySelector("select, button");
      if (f && document.activeElement === document.body) f.focus();
    }
    function msg(text, bad) {
      var el = document.getElementById("ensPrefMsg");
      if (el) { el.textContent = text; el.className = "ens-prefmsg" + (bad ? " bad" : ""); }
    }
    function label(ch) {
      for (var i = 0; i < CHANNELS.length; i++) if (CHANNELS[i][0] === ch) return CHANNELS[i][1];
      return ch;
    }
    loadPrefs().then(function (p) { cur = p; paint(); },
                     function () { failed = true; paint(); });

    async function muteAll() {
      var done = 0;
      for (var i = 0; i < CHANNELS.length; i++) {
        var ch = CHANNELS[i][0];
        if (prefsOff[ch]) continue;
        try { await savePref(ch, "none"); cur[ch] = "none"; done++; }
        catch (err) {
          if (channelRejected(err)) prefsOff[ch] = true;
          else { paint(); msg("Couldn't save that just now.", true); return; }
        }
      }
      paint();
      // every channel above, and no claim about the one that isn't there
      if (done) msg("Muted every channel above. Urgent announcements still reach you.");
      else msg("This workspace's database doesn't accept those settings yet.", true);
    }

    wrap.addEventListener("change", function (e) {
      var sel = e.target;
      if (!sel || !sel.getAttribute || !sel.getAttribute("data-ch")) return;
      var ch = sel.getAttribute("data-ch"), lvl = sel.value, was = cur[ch] || "all";
      msg("Saving…");
      savePref(ch, lvl).then(function () {
        cur[ch] = lvl;
        msg(lvl === "none"
          ? "“" + label(ch) + "” muted. Urgent announcements still reach you."
          : "Saved.");
      }, function (err) {
        if (channelRejected(err)) {
          prefsOff[ch] = true; paint();
          msg("“" + label(ch) + "” isn't a setting this workspace's database " +
              "accepts yet, so it wasn't saved. The rest above are.", true);
          return;
        }
        sel.value = was;
        msg("Couldn't save that just now.", true);
      });
    });
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || e.target.id === "ensPrefClose") { close(); return; }
      if (e.target.id === "ensPrefMute") { msg("Muting…"); muteAll(); }
    });
  }

  /* The bell ships with the shell, so its styles ride along with it: every
     /ensemble/ page gets the reader by loading core.js, with no per-page
     stylesheet link to remember. Same tokens as ensemble.css. */
  function notifCss() {
    if (document.getElementById("ens-notif-css")) return;
    var css = [
      ".ens-bell{position:relative;flex:none;margin-left:auto;display:inline-flex;align-items:center;",
      "  justify-content:center;width:38px;height:38px;border:0;border-radius:11px;",
      "  background:rgba(255,255,255,0.12);color:#fff;cursor:pointer;font:inherit;}",
      ".ens-bell:hover{background:rgba(255,255,255,0.2);}",
      ".ens-bell svg{width:19px;height:19px;}",
      ".ens-bell-n{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;padding:0 5px;",
      "  border-radius:999px;background:var(--gold);color:#16233d;font-size:11px;font-weight:800;",
      "  line-height:18px;text-align:center;}",
      ".ens-notif{flex-direction:column;align-items:flex-start;gap:3px;}",
      ".ens-notif b{font-weight:700;font-size:14px;line-height:1.35;}",
      ".ens-notif span{font-size:12px;}",
      ".ens-notif-acts{display:flex;gap:8px;margin-top:12px;}",
      ".ens-notif-acts .tab{flex:1;text-align:center;justify-content:center;}",
      ".ens-prefrow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 2px;}",
      ".ens-prefrow b{font-size:14px;font-weight:650;}",
      ".ens-prefrow select{flex:0 1 190px;min-width:0;}",
      ".ens-preflab{display:flex;flex-direction:column;gap:2px;min-width:0;}",
      ".ens-prefhint{font-size:12px;line-height:1.45;color:var(--muted);}",
      ".ens-prefmsg{min-height:18px;margin:8px 2px 0;font-size:12.5px;color:var(--muted);}",
      ".ens-prefmsg.bad{color:var(--bad);}",
    ].join("\n");
    var st = document.createElement("style"); st.id = "ens-notif-css"; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── boot: require sign-in, load orgs, mount shell, hand control back ── */
  async function start(opts) {
    opts = opts || {};
    var main = document.getElementById("ensMain");
    function gate(html) { if (main) main.innerHTML = html; }

    // wait for account.js to settle its session
    if (window.CadAccount && !CadAccount.ready()) {
      await new Promise(function (r) {
        var done = false;
        CadAccount.onChange(function () { if (!done) { done = true; r(); } });
        setTimeout(function () { if (!done) { done = true; r(); } }, 2500);
      });
    }
    if (!window.CadAccount || !CadAccount.user()) {
      mountShell(opts.nav || "home"); // brand + the way back to Scores, even signed out
      gate('<div class="card" style="max-width:520px;margin:24px auto">' +
        "<h2>Sign in to Cadence</h2>" +
        '<p class="setnote">Cadence Ensemble is your organization\'s private workspace. ' +
        "Sign in with your Cadence account — the same one you use for scores.</p>" +
        '<form class="acct-form" id="ensSignIn"><input class="ctrl" type="email" id="ensEmail" ' +
        'placeholder="you@example.com" autocomplete="email" required>' +
        '<button class="tab" type="submit">Email me a sign-in link</button></form>' +
        '<p class="acct-msg" id="ensMsg" role="status"></p></div>');
      var f = document.getElementById("ensSignIn");
      if (f) f.addEventListener("submit", function (e) {
        e.preventDefault();
        var msg = document.getElementById("ensMsg");
        msg.className = "acct-msg"; msg.textContent = "Sending…";
        CadAccount.signIn(document.getElementById("ensEmail").value).then(function () {
          msg.className = "acct-msg ok";
          msg.textContent = "Link sent — open it on this device to finish signing in.";
        }).catch(function (err) {
          msg.className = "acct-msg err";
          msg.textContent = "Couldn't send that link" + (err && err.message ? " — " + err.message : "") + ".";
        });
      });
      return null;
    }

    try { await loadOrgs(); } catch (e) {
      gate('<div class="card"><div class="empty">Couldn\'t reach your workspaces. ' +
        "If this is a fresh install, the Ensemble database migrations may not be applied yet.</div></div>");
      return null;
    }

    var wanted = null;
    try { wanted = new URLSearchParams(location.search).get("org") || localStorage.getItem(CUR_KEY); } catch (e) {}
    pick(wanted);

    if (!state.org && !opts.allowNoOrg) { location.href = "index.html"; return null; }
    mountShell(opts.nav || "home");
    return state.org;
  }

  window.CadOrg = {
    PLANS: PLANS, PRO_FEATURES: PRO_FEATURES,
    start: start, rest: rest, rpc: rpc, esc: esc, log: log,
    orgs: function () { return state.orgs || []; },
    current: function () { return state.org; },
    member: function () { return state.member; },
    role: function () { return state.role; },
    perms: function () { return state.perms.slice(); },
    can: can, canDo: canDo,
    canUseFeature: canUseFeature, isWritable: isWritable,
    trialDaysLeft: trialDaysLeft, planOf: planOf,
    reload: loadOrgs, select: pick, mountShell: mountShell,
    notifUnread: function () { return notif.count; },
    openNotifications: openNotifSheet, openNotifPrefs: openPrefsSheet,
    // the pieces scripts/test_notify_ui.js drives directly
    _notif: {
      query: notifQuery, markAllPath: notifAllPath, link: notifLink,
      samePage: samePageAs, go: notifGo,
      setUnread: setUnread, load: loadNotifs, markRead: markRead,
      markAllRead: markAllRead, savePref: savePref, rejected: channelRejected,
      channels: function () { return CHANNELS.map(function (c) { return c[0]; }); },
      state: notif,
    },
  };
})();
