/* Cadence Ensemble — shared people/roster helpers.
   Loaded after core.js by members.html, admin.html and billing.html.

   Owns the things those three screens must agree on:
     · the permission vocabulary (mirrors the comment in 0005_ensemble_core.sql)
     · member row rendering and status/role chips
     · contact-visibility rules — org_member_contacts is a SEPARATE, stricter
       table, and this file never pretends the UI decides who may read it
     · CSV roster parsing for bulk invites
     · invite-code generation and copyable links
     · an exact-count helper so dashboards never download whole tables

   Nothing here is a security boundary. Every rule below is also enforced by
   RLS in 0005 and 0009; the UI checks exist so people aren't shown buttons
   and fields that would fail. */
(function () {
  "use strict";
  var esc = window.CadOrg ? CadOrg.esc : function (s) { return String(s == null ? "" : s); };

  /* ── permission vocabulary ────────────────────────────────────────────
     Grouped for the role editor. Keys must match 0005 exactly. */
  var PERM_GROUPS = [
    { title: "Workspace", perms: [
      ["org.admin", "Full admin — implies every permission below"],
      ["billing.manage", "Manage the subscription, billing contacts and invoices"],
      ["audit.view", "View the audit log"],
      ["member.manage", "Add, edit and remove members; manage roles and invites"],
    ] },
    { title: "Announcements & messaging", perms: [
      ["announce.view", "See announcements"],
      ["announce.create", "Post announcements"],
      ["announce.edit", "Edit or delete anyone's announcement"],
      ["announce.urgent", "Send urgent announcements"],
      ["chat.create", "Start group chats"],
      ["chat.moderate", "Moderate chats"],
    ] },
    { title: "Calendar & attendance", perms: [
      ["event.create", "Create events"],
      ["event.edit", "Edit anyone's event"],
      ["attendance.view", "See attendance records"],
      ["attendance.edit", "Take and change attendance"],
    ] },
    { title: "Files & music", perms: [
      ["file.view", "See files and music"],
      ["file.upload", "Upload files"],
      ["file.manage", "Move, rename and delete files"],
    ] },
    { title: "Groups & operations", perms: [
      ["group.create", "Create groups"],
      ["group.manage", "Manage group membership"],
      ["drill.manage", "Design drill and assign dots"],
      ["form.manage", "Create forms and read submissions"],
      ["signup.manage", "Manage volunteer sign-ups"],
      ["task.manage", "Assign and manage tasks"],
      ["poll.manage", "Create polls"],
      ["assignment.manage", "Assign music and drill"],
      ["audition.manage", "Run auditions"],
      ["equipment.manage", "Track equipment and uniforms"],
    ] },
    { title: "Sensitive information", perms: [
      ["staff.access", "Access the staff-only workspace"],
      ["student.info", "Read student information — including medical forms"],
      ["parent.info", "Read parent and guardian contact information"],
    ] },
    { title: "Public Cadence", perms: [
      ["public.manage", "Edit the public ensemble profile (Ensemble Pro)"],
    ] },
  ];

  var ALL_PERMS = PERM_GROUPS.reduce(function (a, g) {
    return a.concat(g.perms.map(function (p) { return p[0]; }));
  }, []);

  var ROLE_KINDS = [
    ["owner", "Owner"], ["staff", "Staff"], ["leadership", "Leadership"],
    ["member", "Member"], ["parent", "Parent / Guardian"], ["booster", "Booster"],
    ["volunteer", "Volunteer"], ["alumni", "Alumni"], ["guest", "Guest"],
  ];

  var MEMBER_STATUSES = [
    ["active", "Active"], ["pending", "Pending"],
    ["inactive", "Inactive"], ["alumni", "Alumni"],
  ];

  var GROUP_KINDS = [
    ["ensemble", "Ensemble"], ["section", "Section"], ["staff", "Staff"],
    ["leadership", "Leadership"], ["parent", "Parent"], ["booster", "Booster"],
    ["volunteer", "Volunteer"], ["community", "Community"], ["custom", "Custom"],
  ];

  /* ── exact counts without downloading rows ────────────────────────────
     PostgREST returns the row count in Content-Range when asked with
     Prefer: count=exact. CadOrg.rest() throws away headers, so this does
     its own fetch — the only place in Ensemble that needs to. Returns null
     when the table doesn't exist yet (other phases land separately). */
  function authToken() {
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

  // count rows matching a PostgREST path. Most tables count on their id
  // column; pass `sel` when a table has no id (composite PK) or when an
  // embedded !inner join is needed to scope the count.
  async function count(path, sel) {
    var cfg = window.CAD_SUPABASE;
    if (!cfg) return null;
    var t = authToken();
    var headers = { apikey: cfg.publishableKey, Prefer: "count=exact", Range: "0-0" };
    if (t) headers.Authorization = "Bearer " + t;
    var hasSelect = /[?&]select=/.test(path);
    var url = cfg.url + "/rest/v1/" + path;
    if (!hasSelect) url += (path.indexOf("?") >= 0 ? "&" : "?") + "select=" + (sel || "id");
    var res = await fetch(url, { headers: headers });
    if (!res.ok) throw new Error("count failed " + res.status);
    var cr = res.headers.get("content-range") || "";
    var n = parseInt(cr.split("/")[1], 10);
    return isNaN(n) ? null : n;
  }

  /* count(), but a missing table or a blocked read renders as "—" instead of
     breaking a dashboard built from tables other phases still owe us. */
  async function softCount(path, sel) {
    try { return await count(path, sel); } catch (e) { return null; }
  }

  /* ── formatting ───────────────────────────────────────────────────────── */
  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
    return parts.map(function (p) { return p.charAt(0).toUpperCase(); }).join("") || "?";
  }

  function memberName(m) {
    return (m && (m.display_name || (m.profile && m.profile.display_name))) || "Unnamed member";
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function relTime(iso) {
    if (!iso) return "";
    var s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 604800) return Math.floor(s / 86400) + "d ago";
    return fmtDate(iso);
  }

  function bytes(n) {
    n = Number(n) || 0;
    var u = ["B", "KB", "MB", "GB", "TB"], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + " " + u[i];
  }

  function money(cents, currency) {
    var v = (Number(cents) || 0) / 100;
    try {
      return v.toLocaleString(undefined, {
        style: "currency", currency: (currency || "usd").toUpperCase(),
        minimumFractionDigits: v % 1 ? 2 : 0,
      });
    } catch (e) { return "$" + v.toFixed(2); }
  }

  /* ── contact visibility ───────────────────────────────────────────────
     org_member_contacts is a separate table with its own, stricter policy
     (0005): a member may read their OWN row, and staff holding
     student.info / parent.info / member.manage may read any row in the org.
     organizations.settings.directory_contacts_visible_to only ever NARROWS
     what the directory shows — it can never widen RLS. */
  function contactPolicy(org) {
    var s = (org && org.settings) || {};
    var v = s.directory_contacts_visible_to;
    return v === "members" || v === "none" ? v : "staff";
  }

  function isStaffForContacts() {
    return !!(window.CadOrg &&
      (CadOrg.can("student.info") || CadOrg.can("parent.info") || CadOrg.can("member.manage")));
  }

  /* opts: { isSelf: bool, isGuardian: bool } */
  function canSeeContacts(org, opts) {
    opts = opts || {};
    if (opts.isSelf) return true;                 // always your own details
    if (isStaffForContacts()) return true;        // staff, per RLS
    if (opts.isGuardian) return true;             // your own student
    // Everyone else depends on the org's directory policy — and even when it
    // says "members", the database still refuses. See contactPolicyNote().
    return false;
  }

  function contactPolicyNote(org) {
    var p = contactPolicy(org);
    if (p === "none") return "Contact details are hidden from the directory for everyone but staff.";
    if (p === "members") return "This workspace is set to share contacts with all members, " +
      "but the database policy still limits contact rows to staff and the member themselves. " +
      "Widening it is a migration, not a switch — that is deliberate.";
    return "Contact details are visible to staff, to the member themselves, and to their guardians.";
  }

  /* ── rendering ────────────────────────────────────────────────────────── */
  function statusTag(status) {
    var cls = status === "active" ? "normal" : status === "pending" ? "important" : "normal";
    if (status === "inactive") cls = "urgent";
    var label = (MEMBER_STATUSES.filter(function (s) { return s[0] === status; })[0] || [null, status])[1];
    return '<span class="ens-tag ' + cls + '">' + esc(label || status) + "</span>";
  }

  /* One member row, used by the directory and by admin lists.
     opts: { subtitle, tag, selectable } */
  function memberRowHtml(m, opts) {
    opts = opts || {};
    var name = memberName(m);
    var role = (m.role && m.role.name) || "";
    var bits = [role, m.section, m.instrument, m.leadership_title]
      .filter(Boolean).map(esc).join(" · ");
    return '<button class="ppl-row" type="button" data-member="' + esc(m.id) + '">' +
      '<span class="ppl-av">' + esc(initials(name)) + "</span>" +
      '<span class="ppl-main"><b>' + esc(name) + "</b>" +
      '<span class="ppl-sub">' + (bits || "—") + "</span></span>" +
      '<span class="ppl-tags">' + (m.status !== "active" ? statusTag(m.status) : "") +
      (opts.tag || "") + "</span></button>";
  }

  function roleOptionsHtml(roles, selectedId) {
    return (roles || []).map(function (r) {
      return '<option value="' + esc(r.id) + '"' + (r.id === selectedId ? " selected" : "") +
        ">" + esc(r.name) + "</option>";
    }).join("");
  }

  /* ── role / permission editor ─────────────────────────────────────────── */
  function permissionEditorHtml(selected, opts) {
    opts = opts || {};
    var sel = selected || [];
    var admin = sel.indexOf("org.admin") >= 0;
    return PERM_GROUPS.map(function (g) {
      return '<fieldset class="ppl-perms"><legend>' + esc(g.title) + "</legend>" +
        g.perms.map(function (p) {
          var on = sel.indexOf(p[0]) >= 0;
          var implied = admin && p[0] !== "org.admin";
          return '<label class="ppl-perm' + (implied ? " implied" : "") + '">' +
            '<input type="checkbox" data-perm="' + esc(p[0]) + '"' +
            (on ? " checked" : "") + (opts.disabled ? " disabled" : "") + ">" +
            "<span><code>" + esc(p[0]) + "</code>" +
            '<span class="ppl-perm-d">' + esc(p[1]) + (implied ? " (granted by org.admin)" : "") +
            "</span></span></label>";
        }).join("") + "</fieldset>";
    }).join("");
  }

  function readPermissionEditor(root) {
    return Array.prototype.slice.call(root.querySelectorAll("[data-perm]"))
      .filter(function (i) { return i.checked; })
      .map(function (i) { return i.dataset.perm; });
  }

  /* ── CSV roster parsing (bulk invite) ─────────────────────────────────
     Accepts `name,email,role,section` with or without a header row, quoted
     fields, and CRLF. Returns { rows, errors, skipped } — never throws, so a
     messy paste from a spreadsheet degrades into a reviewable list. */
  function splitCsvLine(line) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === "," || c === "\t" || c === ";") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function parseRoster(text) {
    var rows = [], errors = [], seen = {};
    var lines = String(text || "").split(/\r?\n/);
    lines.forEach(function (raw, idx) {
      var line = raw.trim();
      if (!line) return;
      var cells = splitCsvLine(line);
      var lower = cells.map(function (c) { return c.toLowerCase(); });
      if (idx === 0 && (lower[0] === "name" || lower.indexOf("email") >= 0)) return; // header
      var name = cells[0] || "";
      var email = (cells[1] || "").toLowerCase();
      // tolerate `email,name` order when the first cell is obviously an email
      if (!EMAIL_RE.test(email) && EMAIL_RE.test(name.toLowerCase())) {
        email = name.toLowerCase(); name = cells[1] || "";
      }
      if (!email) { errors.push("Line " + (idx + 1) + ": no email address — skipped."); return; }
      if (!EMAIL_RE.test(email)) {
        errors.push("Line " + (idx + 1) + ": “" + email + "” doesn't look like an email — skipped.");
        return;
      }
      if (seen[email]) { errors.push("Line " + (idx + 1) + ": duplicate of " + email + " — skipped."); return; }
      seen[email] = true;
      rows.push({
        name: name, email: email,
        role: (cells[2] || "").trim(),
        section: (cells[3] || "").trim(),
        line: idx + 1,
      });
    });
    return { rows: rows, errors: errors };
  }

  /* Match a free-text role cell ("Parent", "section leader") to an org role. */
  function matchRole(roles, text) {
    var t = String(text || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!t) return null;
    var byKey = (roles || []).filter(function (r) { return r.key.toLowerCase() === t; })[0];
    if (byKey) return byKey;
    return (roles || []).filter(function (r) {
      return r.name.toLowerCase().replace(/[\s-]+/g, "_") === t;
    })[0] || null;
  }

  /* ── invite codes ─────────────────────────────────────────────────────
     Readable, unambiguous alphabet (no 0/O/1/I), generated in the browser
     with crypto randomness. Uniqueness is enforced by the unique index on
     org_invites.code — a collision surfaces as an insert error, and callers
     simply retry with a fresh code. */
  var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function makeInviteCode(len) {
    len = len || 8;
    var out = "", buf;
    try {
      buf = new Uint32Array(len);
      crypto.getRandomValues(buf);
    } catch (e) { buf = null; }
    for (var i = 0; i < len; i++) {
      var n = buf ? buf[i] : Math.floor(Math.random() * 4294967296);
      out += CODE_ALPHABET.charAt(n % CODE_ALPHABET.length);
      if (i === 3 && len > 4) out += "-";
    }
    return out;
  }

  function inviteUrl(code) {
    var base = location.href.replace(/[^/]*$/, "");
    return base + "index.html?invite=" + encodeURIComponent(code);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (e2) { return false; }
    }
  }

  /* ── group tree ───────────────────────────────────────────────────────
     org_groups nests (Trumpets ⊂ Brass ⊂ Full Ensemble). Returns roots with
     .children, cycle-safe. */
  function groupTree(groups) {
    var byId = {}, roots = [];
    (groups || []).forEach(function (g) { byId[g.id] = Object.assign({}, g, { children: [] }); });
    Object.keys(byId).forEach(function (id) {
      var g = byId[id];
      var p = g.parent_id && byId[g.parent_id];
      if (p && p.id !== g.id) p.children.push(g); else roots.push(g);
    });
    function sortRec(list) {
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
      list.forEach(function (g) { sortRec(g.children); });
    }
    sortRec(roots);
    return roots;
  }

  function flattenTree(roots, depth) {
    depth = depth || 0;
    var out = [];
    (roots || []).forEach(function (g) {
      out.push({ group: g, depth: depth });
      out = out.concat(flattenTree(g.children, depth + 1));
    });
    return out;
  }

  /* ── small DOM helpers shared by the three screens ────────────────────── */
  function drawer(html, onClose) {
    var wrap = document.createElement("div");
    wrap.className = "ppl-drawer";
    wrap.innerHTML = '<div class="ppl-drawer-in" role="dialog" aria-modal="true">' +
      '<button class="ppl-x" type="button" aria-label="Close">×</button>' + html + "</div>";
    document.body.appendChild(wrap);
    function close() {
      wrap.remove();
      document.removeEventListener("keydown", onKey);
      if (onClose) onClose();
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || (e.target.classList && e.target.classList.contains("ppl-x"))) close();
    });
    return { el: wrap.querySelector(".ppl-drawer-in"), close: close };
  }

  function toast(msg, bad) {
    var t = document.createElement("div");
    t.className = "ppl-toast" + (bad ? " bad" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  window.CadPeople = {
    PERM_GROUPS: PERM_GROUPS, ALL_PERMS: ALL_PERMS, ROLE_KINDS: ROLE_KINDS,
    MEMBER_STATUSES: MEMBER_STATUSES, GROUP_KINDS: GROUP_KINDS,
    count: count, softCount: softCount,
    initials: initials, memberName: memberName,
    fmtDate: fmtDate, fmtDateTime: fmtDateTime, relTime: relTime,
    bytes: bytes, money: money,
    contactPolicy: contactPolicy, canSeeContacts: canSeeContacts,
    contactPolicyNote: contactPolicyNote,
    statusTag: statusTag, memberRowHtml: memberRowHtml, roleOptionsHtml: roleOptionsHtml,
    permissionEditorHtml: permissionEditorHtml, readPermissionEditor: readPermissionEditor,
    parseRoster: parseRoster, matchRole: matchRole,
    makeInviteCode: makeInviteCode, inviteUrl: inviteUrl, copyText: copyText,
    groupTree: groupTree, flattenTree: flattenTree,
    drawer: drawer, toast: toast,
  };
})();
