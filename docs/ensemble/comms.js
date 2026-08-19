/* Cadence Ensemble — communication helpers shared by feed.html and messages.html.
   Loaded after core.js on both screens.

   Owns:
     • the org directory cache (members, roles, groups, group membership) that
       both screens need to name people and count an audience;
     • post rendering — priority tag, pin, targeting label, acknowledgment bar,
       reactions and comments — plus the wiring that makes those controls work;
     • the audience/target picker used by the composer;
     • a Realtime subscription helper (postgres_changes, not polling).

   Nothing here is a security boundary. Every rule mirrored in this file is
   also enforced by RLS in supabase/migrations/0006_ensemble_comms.sql —
   can_see_post(), org_can_write(), pair_may_dm(). The UI checks exist so
   people aren't shown buttons that would fail. */
(function () {
  "use strict";
  if (!window.CadOrg) return;
  var esc = CadOrg.esc;

  var PRIORITIES = [
    ["normal", "Normal", "normal"],
    ["important", "Important", "important"],
    ["urgent", "Urgent", "urgent"],
  ];

  /* role kinds, as org_roles.kind spells them (see 0005) */
  var ROLE_KINDS = [
    ["staff", "Staff"], ["leadership", "Leadership"], ["member", "Members"],
    ["parent", "Parents"], ["booster", "Boosters"], ["volunteer", "Volunteers"],
    ["alumni", "Alumni"], ["guest", "Guests"], ["owner", "Owners"],
  ];

  var EMOJI = ["👍", "🎉", "🔥", "❤️", "😂", "👀"];

  /* ── time ─────────────────────────────────────────────────────────── */
  function when(ts) {
    if (!ts) return "";
    var d = new Date(ts), diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 0) {
      var ahead = -diff;
      if (ahead < 3600) return "in " + Math.max(1, Math.round(ahead / 60)) + "m";
      if (ahead < 86400) return "in " + Math.round(ahead / 3600) + "h";
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.round(diff / 60) + "m ago";
    if (diff < 86400) return Math.round(diff / 3600) + "h ago";
    if (diff < 604800) return Math.round(diff / 86400) + "d ago";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function clock(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  function dayLabel(ts) {
    var d = new Date(ts), today = new Date();
    var same = d.toDateString() === today.toDateString();
    if (same) return "Today";
    var y = new Date(today.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }
  /* value for <input type="datetime-local"> in local time */
  function localInputValue(d) {
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ── the session token account.js persisted (same scan core.js uses) ── */
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

  /* ── directory ─────────────────────────────────────────────────────── */
  var dirCache = null;

  async function loadDirectory(orgId, force) {
    if (dirCache && dirCache.orgId === orgId && !force) return dirCache;
    var members = await CadOrg.rest("org_members?select=id,user_id,display_name,section," +
      "instrument,leadership_title,is_minor,status,role:org_roles!org_members_role_id_fkey(id,key,name,kind)" +
      "&org_id=eq." + orgId + "&order=display_name.asc");
    var groups = await CadOrg.rest("org_groups?select=id,name,kind,parent_id&org_id=eq." +
      orgId + "&order=name.asc");
    var gm = [];
    if (groups.length) {
      gm = await CadOrg.rest("org_group_members?select=group_id,member_id&group_id=in.(" +
        groups.map(function (g) { return g.id; }).join(",") + ")");
    }
    var byId = {}, nameSet = {}, groupMembers = {}, memberGroups = {};
    members.forEach(function (m) {
      m.name = m.display_name || "Member";
      byId[m.id] = m;
      nameSet[esc(m.name).toLowerCase()] = m.id;
    });
    groups.forEach(function (g) { groupMembers[g.id] = []; });
    gm.forEach(function (r) {
      (groupMembers[r.group_id] = groupMembers[r.group_id] || []).push(r.member_id);
      (memberGroups[r.member_id] = memberGroups[r.member_id] || []).push(r.group_id);
    });
    dirCache = {
      orgId: orgId, members: members, byId: byId, nameSet: nameSet,
      groups: groups, groupMembers: groupMembers, memberGroups: memberGroups,
      activeCount: members.filter(function (m) { return m.status === "active"; }).length,
    };
    return dirCache;
  }
  function directory() { return dirCache; }
  function nameOf(id) {
    var d = dirCache, m = d && d.byId[id];
    return m ? m.name : "Someone";
  }
  function isStaffMember(m) {
    return !!(m && m.role && (m.role.kind === "staff" || m.role.kind === "owner"));
  }

  /* ── body rendering: escape first, then links and @mentions ───────── */
  function renderBody(text, dir) {
    var out = esc(String(text == null ? "" : text));
    out = out.replace(/(https?:\/\/[^\s<]+)/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + "</a>";
    });
    var names = (dir || dirCache) && (dir || dirCache).nameSet;
    if (names) {
      out = out.replace(/@([\w.&#;'\-]+(?:\s[\w.&#;'\-]+){0,2})/g, function (whole, run) {
        var parts = run.split(/\s+/);
        for (var n = parts.length; n > 0; n--) {
          var cand = parts.slice(0, n).join(" ");
          if (names[cand.toLowerCase()]) {
            return '<span class="ens-mention">@' + cand + "</span>" +
              (n < parts.length ? " " + parts.slice(n).join(" ") : "");
          }
        }
        return whole;
      });
    }
    return out.replace(/\n/g, "<br>");
  }

  /* ── audience maths ───────────────────────────────────────────────── */
  function audienceMembers(targets, dir) {
    dir = dir || dirCache;
    if (!dir) return [];
    var active = dir.members.filter(function (m) { return m.status === "active"; });
    if (!targets || !targets.length) return active;
    var set = {};
    targets.forEach(function (t) {
      if (t.member_id) set[t.member_id] = 1;
      else if (t.group_id) (dir.groupMembers[t.group_id] || []).forEach(function (id) { set[id] = 1; });
      else if (t.role_kind) active.forEach(function (m) {
        if (m.role && m.role.kind === t.role_kind) set[m.id] = 1;
      });
    });
    return active.filter(function (m) { return set[m.id]; });
  }

  function audienceLabel(targets, dir) {
    dir = dir || dirCache;
    if (!targets || !targets.length) return "Everyone";
    var bits = [];
    var groups = targets.filter(function (t) { return t.group_id; });
    var kinds = targets.filter(function (t) { return t.role_kind; });
    var people = targets.filter(function (t) { return t.member_id; });
    groups.forEach(function (t) {
      var g = dir && dir.groups.filter(function (x) { return x.id === t.group_id; })[0];
      bits.push(g ? g.name : "a group");
    });
    kinds.forEach(function (t) {
      var k = ROLE_KINDS.filter(function (r) { return r[0] === t.role_kind; })[0];
      bits.push(k ? k[1] : t.role_kind);
    });
    if (people.length) bits.push(people.length + (people.length === 1 ? " person" : " people"));
    return bits.join(", ");
  }

  /* ── post card ────────────────────────────────────────────────────── */
  /* ctx: { dir, myMemberId, canModerate, canAckFeature, showAdmin } */
  function postHtml(p, ctx) {
    var dir = ctx.dir || dirCache;
    var targets = p.targets || [];
    var acks = p.acks || [];
    var reads = p.reads || [];
    var comments = (p.comments || []).filter(function (c) { return !c.deleted_at; })
      .sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
    var reactions = p.reactions || [];
    var mine = p.author_member_id === ctx.myMemberId;
    var canEdit = mine || ctx.canModerate;
    var audience = audienceMembers(targets, dir);
    var scheduled = p.publish_at && new Date(p.publish_at) > new Date();

    var tags = "";
    if (p.priority === "urgent") tags += '<span class="ens-tag urgent">Urgent</span>';
    else if (p.priority === "important") tags += '<span class="ens-tag important">Important</span>';
    if (p.kind === "announcement" && p.priority === "normal") tags += '<span class="ens-tag normal">Announcement</span>';
    if (p.pinned) tags += '<span class="ens-tag important">Pinned</span>';
    if (scheduled) tags += '<span class="ens-tag normal">Scheduled ' + esc(when(p.publish_at)) + "</span>";
    if (p.archived) tags += '<span class="ens-tag normal">Archived</span>';

    /* acknowledgment bar */
    var ackBar = "";
    var iAcked = acks.some(function (a) { return a.member_id === ctx.myMemberId; });
    var iRead = reads.some(function (r) { return r.member_id === ctx.myMemberId; });
    if (p.requires_ack) {
      var pct = audience.length ? Math.round((acks.length / audience.length) * 100) : 0;
      if (ctx.canModerate) {
        var missing = audience.filter(function (m) {
          return !acks.some(function (a) { return a.member_id === m.id; });
        });
        ackBar +=
          '<div class="ens-ack">' +
            "<div><b>" + acks.length + " of " + audience.length + " acknowledged</b>" +
            '<div class="ens-meter"><i style="width:' + pct + '%"></i></div></div>' +
            (missing.length
              ? '<button class="tab ens-mini" type="button" data-act="who">' +
                missing.length + " haven't</button>"
              : '<span class="setsub">Everyone is in.</span>') +
          "</div>" +
          '<div class="ens-missing" data-missing hidden>' +
            (missing.length
              ? missing.map(function (m) {
                  return '<span class="classchip">' + esc(m.name) +
                    (m.section ? " · " + esc(m.section) : "") + "</span>";
                }).join("")
              : "") +
          "</div>";
      }
      if (!iAcked && !scheduled) {
        ackBar += '<button class="tab on ens-ackbtn" type="button" data-act="ack">' +
          "Acknowledge — I've read this</button>";
      } else if (iAcked) {
        ackBar += '<span class="ens-done">✓ You acknowledged this</span>';
      }
    } else if (!scheduled) {
      ackBar += iRead
        ? '<span class="ens-done">✓ Seen</span>'
        : '<button class="tab ens-mini" type="button" data-act="seen">I\'ve seen this</button>';
      if (ctx.canModerate) {
        ackBar += '<span class="setsub ens-readcount">' + reads.length + " of " +
          audience.length + " have opened this</span>";
      }
    }

    /* reactions */
    var counts = {};
    reactions.forEach(function (r) {
      counts[r.emoji] = counts[r.emoji] || { n: 0, me: false };
      counts[r.emoji].n++;
      if (r.member_id === ctx.myMemberId) counts[r.emoji].me = true;
    });
    var reactHtml = EMOJI.map(function (e) {
      var c = counts[e];
      return '<button class="ens-react' + (c && c.me ? " on" : "") + '" type="button" ' +
        'data-act="react" data-emoji="' + e + '">' + e +
        (c && c.n ? ' <b>' + c.n + "</b>" : "") + "</button>";
    }).join("");

    /* comments */
    var commentHtml = comments.map(function (c) {
      var own = c.member_id === ctx.myMemberId;
      return '<div class="ens-comment" data-comment="' + esc(c.id) + '">' +
        "<b>" + esc(nameOf(c.member_id)) + "</b> " +
        '<span class="ens-when2">' + esc(when(c.created_at)) + "</span>" +
        (own || ctx.canModerate
          ? '<button class="ens-x" type="button" data-act="delcomment" title="Delete">×</button>'
          : "") +
        "<div>" + renderBody(c.body, dir) + "</div></div>";
    }).join("");

    return '<article class="card ens-post" data-post="' + esc(p.id) + '">' +
      '<div class="ens-h">' +
        "<h2>" + esc(p.title || (p.kind === "announcement" ? "Announcement" : "Post")) + "</h2>" +
        '<span class="ens-tags">' + tags + "</span>" +
      "</div>" +
      '<div class="setsub ens-byline">' + esc(nameOf(p.author_member_id)) + " · " +
        esc(when(p.publish_at || p.created_at)) + " · to " + esc(audienceLabel(targets, dir)) +
        (p.updated_at && p.updated_at !== p.created_at ? " · edited" : "") + "</div>" +
      '<div class="ens-postbody">' + renderBody(p.body, dir) + "</div>" +
      (ackBar ? '<div class="ens-ackwrap">' + ackBar + "</div>" : "") +
      '<div class="ens-reactrow">' + reactHtml +
        '<button class="ens-react" type="button" data-act="togglecomments"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="M5 5.5h14v9.5H9.5L5 19z"/></svg> ' +
          (comments.length || "Comment") + "</button>" +
        (canEdit
          ? '<span class="ens-admin">' +
            '<button class="tab ens-mini" type="button" data-act="edit">Edit</button>' +
            '<button class="tab ens-mini" type="button" data-act="pin">' +
              (p.pinned ? "Unpin" : "Pin") + "</button>" +
            '<button class="tab ens-mini" type="button" data-act="archive">' +
              (p.archived ? "Restore" : "Archive") + "</button></span>"
          : "") +
      "</div>" +
      '<div class="ens-commentwrap"' + (comments.length ? "" : " hidden") + '>' +
        '<div class="ens-comments">' + commentHtml + "</div>" +
        '<form class="acct-form ens-cform" data-act="comment">' +
          '<input class="ctrl" name="body" placeholder="Write a comment…" maxlength="2000" required>' +
          '<button class="tab" type="submit">Send</button></form>' +
      "</div>" +
    "</article>";
  }

  /* ── post actions (thin REST wrappers; RLS is the real gate) ──────── */
  async function ack(postId, memberId) {
    return CadOrg.rest("post_acks", { method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: { post_id: postId, member_id: memberId } });
  }
  async function markRead(postId, memberId) {
    return CadOrg.rest("post_reads", { method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: { post_id: postId, member_id: memberId } });
  }
  async function toggleReaction(postId, memberId, emoji, on) {
    if (on) {
      return CadOrg.rest("post_reactions", { method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: { post_id: postId, member_id: memberId, emoji: emoji } });
    }
    return CadOrg.rest("post_reactions?post_id=eq." + postId + "&member_id=eq." +
      memberId + "&emoji=eq." + encodeURIComponent(emoji), { method: "DELETE" });
  }
  async function comment(postId, memberId, body) {
    return CadOrg.rest("post_comments", { method: "POST",
      headers: { Prefer: "return=representation" },
      body: { post_id: postId, member_id: memberId, body: body } });
  }

  /* ── audience / target picker ─────────────────────────────────────── */
  var AUDIENCES = [
    ["all", "Whole organization"],
    ["groups", "Specific groups"],
    ["staff", "Staff only"],
    ["parents", "Parents only"],
    ["people", "Individuals"],
  ];

  function targetPickerHtml(dir, id) {
    id = id || "tp";
    return '<div class="ens-target" data-picker="' + esc(id) + '">' +
      '<div class="setrow-classes ens-chips">' +
        AUDIENCES.map(function (a, i) {
          return '<button type="button" class="classchip' + (i === 0 ? " on" : "") +
            '" data-aud="' + a[0] + '">' + a[1] + "</button>";
        }).join("") +
      "</div>" +
      '<div class="ens-pane" data-pane="groups" hidden>' +
        (dir.groups.length
          ? '<div class="ens-chips">' + dir.groups.map(function (g) {
              return '<button type="button" class="classchip" data-group="' + esc(g.id) + '">' +
                esc(g.name) + "</button>";
            }).join("") + "</div>"
          : '<p class="setsub">No groups yet — create sections and staff rooms on the Members screen.</p>') +
      "</div>" +
      '<div class="ens-pane" data-pane="people" hidden>' +
        '<input class="ctrl" data-people-search placeholder="Search members…">' +
        '<div class="ens-chips ens-people">' + dir.members.filter(function (m) {
          return m.status === "active";
        }).map(function (m) {
          return '<button type="button" class="classchip" data-member="' + esc(m.id) + '" ' +
            'data-name="' + esc(m.name.toLowerCase()) + '">' + esc(m.name) +
            (m.section ? ' <span class="ens-dim">· ' + esc(m.section) + "</span>" : "") + "</button>";
        }).join("") + "</div>" +
      "</div>" +
      '<p class="setsub" data-aud-note>Everyone in the workspace will see this.</p>' +
    "</div>";
  }

  function wireTargetPicker(root, dir, onChange) {
    var note = root.querySelector("[data-aud-note]");
    function refresh() {
      var aud = root.dataset.aud || "all";
      root.querySelectorAll("[data-pane]").forEach(function (p) {
        p.hidden = p.dataset.pane !== aud;
      });
      var t = readTargets(root);
      var n = audienceMembers(t, dir).length;
      note.textContent = aud === "all"
        ? "Everyone in the workspace will see this — " + n + " active " + (n === 1 ? "member" : "members") + "."
        : t.length
          ? audienceLabel(t, dir) + " — " + n + " " + (n === 1 ? "person" : "people") + " will see this."
          : "Pick at least one audience, or this post reaches nobody.";
      if (onChange) onChange(t);
    }
    root.dataset.aud = "all";
    root.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("button");
      if (!b || !root.contains(b)) return;
      e.preventDefault();
      if (b.dataset.aud) {
        root.dataset.aud = b.dataset.aud;
        root.querySelectorAll("[data-aud]").forEach(function (x) {
          x.classList.toggle("on", x === b);
        });
      } else if (b.dataset.group || b.dataset.member) {
        b.classList.toggle("on");
      } else return;
      refresh();
    });
    var search = root.querySelector("[data-people-search]");
    if (search) search.addEventListener("input", function () {
      var q = search.value.trim().toLowerCase();
      root.querySelectorAll("[data-member]").forEach(function (b) {
        b.hidden = !!q && b.dataset.name.indexOf(q) < 0 && !b.classList.contains("on");
      });
    });
    refresh();
    return { refresh: refresh };
  }

  /* → rows ready for POST /post_targets (post_id added by the caller) */
  function readTargets(root) {
    var aud = root.dataset.aud || "all";
    if (aud === "all") return [];
    if (aud === "staff") return [{ role_kind: "staff" }, { role_kind: "owner" }];
    if (aud === "parents") return [{ role_kind: "parent" }];
    if (aud === "groups") {
      return Array.prototype.map.call(root.querySelectorAll("[data-group].on"), function (b) {
        return { group_id: b.dataset.group };
      });
    }
    return Array.prototype.map.call(root.querySelectorAll("[data-member].on"), function (b) {
      return { member_id: b.dataset.member };
    });
  }

  /* ── Realtime ─────────────────────────────────────────────────────────
     One client per screen, separate from account.js's (persistSession:false
     so it never touches the stored session), authenticated with the same
     access token so RLS applies to the change stream too. */
  function realtime(orgId, handlers) {
    handlers = handlers || {};
    var api = { status: "unavailable", close: function () {}, client: null };
    var lib = window.supabase, cfg = window.CAD_SUPABASE;
    if (!lib || !cfg || !orgId) return api;

    var client;
    try {
      client = lib.createClient(cfg.url, cfg.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 12 } },
      });
    } catch (e) { return api; }
    api.client = client;
    var tk = token();
    if (tk) { try { client.realtime.setAuth(tk); } catch (e) {} }

    function on(ch, table, fn, filter) {
      if (!fn) return ch;
      var opts = { event: "*", schema: "public", table: table };
      if (filter) opts.filter = filter;
      return ch.on("postgres_changes", opts, function (payload) {
        try { fn(payload.new || payload.old || {}, payload); } catch (e) {}
      });
    }

    var ch = client.channel("ens-" + orgId + "-" + Math.random().toString(36).slice(2, 7));
    on(ch, "posts", handlers.onPost, "org_id=eq." + orgId);
    on(ch, "post_comments", handlers.onComment);
    on(ch, "post_acks", handlers.onAck);
    on(ch, "post_reactions", handlers.onPostReaction);
    /* messages carry no org_id, so there is nothing to filter on server-side —
       RLS already limits the stream to chats this member belongs to. */
    on(ch, "messages", handlers.onMessage);
    on(ch, "message_reactions", handlers.onMessageReaction);
    on(ch, "chats", handlers.onChat, "org_id=eq." + orgId);
    ch.subscribe(function (status) {
      api.status = status;
      if (handlers.onStatus) { try { handlers.onStatus(status); } catch (e) {} }
    });

    api.close = function () { try { client.removeAllChannels(); } catch (e) {} };
    return api;
  }

  /* ── youth-safety mirror of pair_may_dm() — for hiding controls only ── */
  function dmPolicy(org, me) {
    var s = (org && org.settings) || {};
    var staff = isStaffMember(me);
    return {
      peers: !!s.student_dms || (staff && true),
      staff: !!s.student_staff_dms || staff,
      /* may this member start any DM at all? */
      any: staff || !!s.student_dms || !!s.student_staff_dms,
    };
  }
  function mayDm(org, me, other) {
    if (!me || !other) return false;
    if (!me.is_minor && !other.is_minor) return true;
    var s = (org && org.settings) || {};
    var a = isStaffMember(me), b = isStaffMember(other);
    if (a && b) return true;
    if (a || b) return !!s.student_staff_dms;
    return !!s.student_dms;
  }
  function mayCreateChat(org) {
    if (!CadOrg.isWritable(org)) return false;
    if (CadOrg.can("chat.create")) return true;
    return !!(org && org.settings && org.settings.member_created_chats);
  }

  window.CadComms = {
    PRIORITIES: PRIORITIES, ROLE_KINDS: ROLE_KINDS, EMOJI: EMOJI, AUDIENCES: AUDIENCES,
    when: when, clock: clock, dayLabel: dayLabel, localInputValue: localInputValue,
    token: token,
    loadDirectory: loadDirectory, directory: directory, nameOf: nameOf,
    isStaffMember: isStaffMember,
    renderBody: renderBody,
    audienceMembers: audienceMembers, audienceLabel: audienceLabel,
    postHtml: postHtml,
    ack: ack, markRead: markRead, toggleReaction: toggleReaction, comment: comment,
    targetPickerHtml: targetPickerHtml, wireTargetPicker: wireTargetPicker,
    readTargets: readTargets,
    realtime: realtime,
    dmPolicy: dmPolicy, mayDm: mayDm, mayCreateChat: mayCreateChat,
  };
})();
