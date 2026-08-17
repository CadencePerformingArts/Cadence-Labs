/* Cadence Ensemble — shared runtime for the private organization side.
   Loaded by every page under /ensemble/ after supabase.js + account.js.

   Owns: the Supabase REST helper (reusing the session account.js persists),
   the current-organization context, permission checks, plan entitlements,
   and the shared app shell so every Ensemble screen is unmistakably Cadence.

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
      "leadership_title,status,display_name,org:organizations(*),role:org_roles(*)" +
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
  var SECTIONS = {
    home:      { label: "Home", href: "home.html",
                 ico: "M4 11.5 12 4l8 7.5M6.5 10v9.5h11V10" },
    feed:      { label: "Announcements", href: "feed.html",
                 ico: "M4 10v4h3l7 4V6l-7 4H4zM17.5 9.5a4 4 0 0 1 0 5" },
    calendar:  { label: "Calendar", href: "calendar.html",
                 ico: "M4.5 5.5h15v14h-15zM4.5 10h15M9 3.5v3.5M15 3.5v3.5" },
    messages:  { label: "Messages", href: "messages.html",
                 ico: "M5 5.5h14v9.5H9.5L5 19z" },
    files:     { label: "Files", href: "files.html",
                 ico: "M4 7.5h5.5l1.8 2H20v9H4z" },
    music:     { label: "Music", href: "music.html",
                 ico: "M9.5 17.5V6l9-1.8V15M9.5 17.5a2.4 2.4 0 1 1-4.8 0 2.4 2.4 0 0 1 4.8 0zm9-2.5a2.4 2.4 0 1 1-4.8 0 2.4 2.4 0 0 1 4.8 0z" },
    drill:     { label: "Drill", href: "drill.html",
                 ico: "M3.5 5.5h17v13h-17zM12 5.5v13M7.5 10.5h.01M12 13.5h.01M16.5 8.5h.01M16.5 15h.01M7.5 15.5h.01" },
    members:   { label: "Members", href: "members.html",
                 ico: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.8 19.5c.4-3 2.7-4.8 5.2-4.8s4.8 1.8 5.2 4.8M16 11a2.6 2.6 0 1 0-1.2-4.9M16.6 14.9c2 .3 3.5 1.9 3.9 4.1" },
    admin:     { label: "Admin", href: "admin.html",
                 ico: "M12 14.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6zM19 12a7 7 0 0 0-.2-1.6l2-1.5-1.8-3-2.3.9A7 7 0 0 0 14 5l-.4-2.4h-3.4L9.9 5a7 7 0 0 0-2.7 1.6L4.9 5.9l-1.8 3 2 1.5a7 7 0 0 0 0 3.2l-2 1.5 1.8 3 2.3-.9a7 7 0 0 0 2.7 1.6l.4 2.4h3.4l.4-2.4a7 7 0 0 0 2.7-1.6l2.3.9 1.8-3-2-1.5c.1-.5.2-1 .2-1.6z" },
    // subpages highlight their parent tab
    billing:   { parent: "admin", label: "Billing", href: "billing.html" },
    event:     { parent: "calendar", label: "Event", href: "event.html" },
  };

  function shellHtml(active) {
    var org = state.org;
    var sec = SECTIONS[active] || SECTIONS.home;
    var lit = sec.parent || (SECTIONS[active] ? active : "home");
    var tabs = "";
    if (org) {
      tabs = Object.keys(SECTIONS).map(function (k) {
        var s = SECTIONS[k];
        if (s.parent) return "";                       // subpages don't get tabs
        if (k === "admin" && !(can("org.admin") || can("member.manage"))) return "";
        return '<a class="ens-tab' + (k === lit ? " on" : "") + '" href="' + s.href + '"' +
          (k === lit ? ' aria-current="page"' : "") + ">" +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + s.ico + '"/></svg>' +
          "<span>" + s.label + "</span></a>";
      }).join("");
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
  }

  function openSwitcher() {
    var wrap = document.createElement("div");
    wrap.className = "ens-sheet";
    wrap.innerHTML = '<div class="ens-sheet-in"><h3>Your workspaces</h3>' +
      (state.orgs || []).map(function (r) {
        return '<button class="ens-sheet-row' + (state.org && r.org.id === state.org.id ? " on" : "") +
          '" data-id="' + r.org.id + '"><b>' + esc(r.org.name) + "</b>" +
          '<span>' + esc((r.role && r.role.name) || "Member") + "</span></button>";
      }).join("") +
      '<a class="ens-sheet-row" href="index.html"><b>+ New or join a workspace</b></a>' +
      '<button class="tab" id="ensSheetClose" type="button" style="margin-top:12px">Close</button></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || e.target.id === "ensSheetClose") { wrap.remove(); return; }
      var row = e.target.closest && e.target.closest("[data-id]");
      if (row) { pick(row.dataset.id); location.reload(); }
    });
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
  };
})();
