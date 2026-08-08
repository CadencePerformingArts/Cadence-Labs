/* Cadence Ensemble Pro — official ensemble profiles.
   Loaded after vendor/supabase.min.js + supabase.js + account.js.

   window.CadEnsembles:
     get(appKey, name)            -> Promise<profile row | null> (cached; published only)
     mountOfficial(el, appKey, name) -> renders the "Official" card into el when a
                                     published profile exists; renders nothing otherwise
     preview(el, row)             -> renders a profile row directly (admin live preview)
     claimUrl(appKey, name)       -> URL into the claim flow on pro.html
     appKey()                     -> this page's app key ('' for DCI at the root)
     appLabel(key)                -> human name for an app key
     rest(path, opts)             -> authed PostgREST fetch (uses the signed-in
                                     session account.js persisted; anon otherwise)

   Reads use a dedicated non-persisting client so account.js stays the only
   GoTrue instance on the page. Writes go through rest(), which reuses the
   session token account.js already keeps fresh in localStorage. Without the
   Supabase lib or config this module quietly no-ops. */
(function () {
  "use strict";
  var cfg = window.CAD_SUPABASE;
  var lib = window.supabase;
  var cache = {};      // "appKey|name" -> Promise<row|null>
  var client = null;

  /* ---- app keys: docs/<key>/ folders, '' is DCI at the root ---- */
  var NS_TO_KEY = {
    "": "", "wgi-guard:": "wgi/guard", "wgi-perc:": "wgi/percussion",
    "wgi-winds:": "wgi/winds", "boa:": "boa", "usb:": "usbands", "uil:": "uil",
    "issma:": "issma", "wgasc:": "wgasc", "tcgc:": "tcgc", "ffcc:": "ffcc",
  };
  var KEY_LABEL = {
    "": "DCI", "wgi/guard": "WGI Color Guard", "wgi/percussion": "WGI Percussion",
    "wgi/winds": "WGI Winds", "boa": "BOA", "usbands": "US Bands", "uil": "UIL Texas",
    "issma": "ISSMA", "wgasc": "WGASC", "tcgc": "TCGC", "ffcc": "FFCC",
  };

  function appKey() {
    var ns = (window.APP_CFG && window.APP_CFG.ns) || "";
    return NS_TO_KEY.hasOwnProperty(ns) ? NS_TO_KEY[ns] : "";
  }
  function appLabel(key) { return KEY_LABEL.hasOwnProperty(key) ? KEY_LABEL[key] : key; }

  function claimUrl(k, name) {
    var root = (window.APP_CFG && window.APP_CFG.root) || ".";
    return root + "/pro.html?claim=" + encodeURIComponent(String(k) + "|" + String(name));
  }

  /* ---- read-only client (no session persistence — account.js owns auth) ---- */
  function sb() {
    if (client) return client;
    if (!cfg || !lib) return null;
    client = lib.createClient(cfg.url, cfg.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return client;
  }

  function get(k, name) {
    var id = String(k) + "|" + String(name);
    if (cache[id]) return cache[id];
    var c = sb();
    if (!c) return Promise.resolve(null);
    cache[id] = c.from("ensemble_profiles")
      .select("id,app_key,ensemble_name,published,content,updated_at")
      .eq("app_key", k).eq("ensemble_name", name).eq("published", true)
      .maybeSingle()
      .then(function (res) { return (res && res.data) || null; })
      .catch(function () { return null; });
    return cache[id];
  }

  /* ---- authed REST: reuse the session account.js persists ---- */
  function sessionToken() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!/^sb-.*-auth-token$/.test(k)) continue;
        var s = JSON.parse(localStorage.getItem(k));
        if (s && s.access_token) return s.access_token;
      }
    } catch (e) {}
    return null;
  }

  function rest(path, opts) {
    if (!cfg) return Promise.reject(new Error("accounts not configured"));
    opts = opts || {};
    var tok = sessionToken();
    var headers = {
      apikey: cfg.publishableKey,
      Authorization: "Bearer " + (tok || cfg.publishableKey),
      "Content-Type": "application/json",
    };
    var extra = opts.headers || {};
    for (var h in extra) headers[h] = extra[h];
    return fetch(cfg.url + "/rest/v1/" + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) {
        var msg = t; try { msg = (JSON.parse(t) || {}).message || t; } catch (e) {}
        throw new Error(msg || ("HTTP " + r.status));
      });
      if (r.status === 204) return null;
      return r.text().then(function (t) { return t ? JSON.parse(t) : null; });
    });
  }

  /* ---- rendering ---- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function safeUrl(u) {
    u = String(u == null ? "" : u).trim();
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[\w.-]+\.[a-z]{2,}([\/?#].*)?$/i.test(u)) return "https://" + u;
    return null;
  }
  function link(u, label) {
    var url = safeUrl(u);
    if (!url) return "";
    return '<a href="' + esc(encodeURI(url)) + '" target="_blank" rel="noopener">' + esc(label) + " ↗</a>";
  }
  function multiline(s) {
    return esc(s).replace(/\n/g, "<br>");
  }

  var CSS_ID = "cad-ensembles-css";
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement("style");
    st.id = CSS_ID;
    st.textContent =
      ".cad-off{background:var(--surface-1);border:1px solid var(--border);border-radius:14px;overflow:hidden}" +
      ".cad-off-cover{width:100%;max-height:180px;object-fit:cover;display:block}" +
      ".cad-off-body{padding:16px 18px 18px}" +
      ".cad-off-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:4px}" +
      ".cad-off-logo{width:44px;height:44px;border-radius:10px;object-fit:contain;flex:none;background:var(--surface-2)}" +
      ".cad-off-name{font-weight:800;font-size:16.5px;color:var(--heading)}" +
      ".cad-off-badge{display:inline-block;border-radius:6px;padding:2px 8px;font-size:10.5px;font-weight:800;" +
        "letter-spacing:.5px;background:var(--accent-wash);color:var(--accent-ink);white-space:nowrap}" +
      ".cad-off p{margin:8px 0 0;font-size:13.5px;line-height:1.55;color:var(--text-secondary)}" +
      ".cad-off-sec{margin-top:12px;padding-top:11px;border-top:1px solid var(--border)}" +
      ".cad-off-sec>b{display:block;font-size:11.5px;font-weight:700;text-transform:uppercase;" +
        "letter-spacing:.6px;color:var(--muted);margin-bottom:5px}" +
      ".cad-off-row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:13.5px;" +
        "border-top:1px solid var(--border)}" +
      ".cad-off-row:first-of-type{border-top:0}" +
      ".cad-off-row span:last-child{color:var(--muted);text-align:right}" +
      ".cad-off-links{display:flex;flex-wrap:wrap;gap:7px 14px;font-size:13.5px}" +
      ".cad-off-chips{display:flex;flex-wrap:wrap;gap:7px}" +
      ".cad-off-chip{background:var(--surface-2);border:1px solid var(--border);border-radius:999px;" +
        "padding:3px 11px;font-size:12.5px;color:var(--text-secondary)}" +
      ".cad-off-ann{padding:8px 0;border-top:1px solid var(--border);font-size:13.5px}" +
      ".cad-off-ann:first-of-type{border-top:0}" +
      ".cad-off-ann b{display:block;font-size:13.5px}" +
      ".cad-off-ann .cad-off-ts{color:var(--muted);font-size:11.5px}" +
      ".cad-off-spon{display:flex;flex-wrap:wrap;gap:7px 14px;font-size:13.5px;align-items:center}" +
      ".cad-off-sptag{font-size:10px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;" +
        "color:var(--muted);border:1px solid var(--baseline);border-radius:5px;padding:1px 5px;margin-right:4px}";
    document.head.appendChild(st);
  }

  function section(label, inner) {
    if (!inner) return "";
    return '<div class="cad-off-sec"><b>' + esc(label) + "</b>" + inner + "</div>";
  }

  function preview(el, row) {
    if (!el) return;
    injectCss();
    if (!row || row.published === false) { el.innerHTML = ""; return; }
    var c = row.content || {};
    var name = row.ensemble_name || "";
    var html = "";

    var cover = safeUrl(c.cover_url);
    if (cover) html += '<img class="cad-off-cover" src="' + esc(encodeURI(cover)) + '" alt="" loading="lazy" onerror="this.hidden=true">';
    html += '<div class="cad-off-body">';

    var logo = safeUrl(c.logo_url);
    html += '<div class="cad-off-head">' +
      (logo ? '<img class="cad-off-logo" src="' + esc(encodeURI(logo)) + '" alt="" loading="lazy" onerror="this.hidden=true">' : "") +
      '<span class="cad-off-name">' + esc(name) + "</span>" +
      '<span class="cad-off-badge">✓ OFFICIAL — MANAGED BY THIS ENSEMBLE</span></div>';

    if (c.description) html += "<p>" + multiline(c.description) + "</p>";

    if (c.show_title || c.repertoire) {
      var showInner = "";
      if (c.show_title) showInner += '<p style="margin-top:0;font-weight:700;color:var(--text-primary)">“' + esc(c.show_title) + "”</p>";
      if (c.repertoire) showInner += '<p style="margin-top:' + (c.show_title ? "4px" : "0") + '">' + multiline(c.repertoire) + "</p>";
      html += section("This year's show", showInner);
    }

    var staff = Array.isArray(c.staff) ? c.staff : [];
    if (staff.length) {
      html += section("Staff", staff.map(function (m) {
        var nm = typeof m === "string" ? m : (m && m.name) || "";
        var role = (m && typeof m === "object" && m.role) || "";
        if (!nm && !role) return "";
        return '<div class="cad-off-row"><span>' + esc(nm) + "</span><span>" + esc(role) + "</span></div>";
      }).join(""));
    }

    var links = [];
    if (c.website) links.push(link(c.website, "Website"));
    var soc = (c.socials && typeof c.socials === "object") ? c.socials : {};
    var SOC_LABELS = { instagram: "Instagram", facebook: "Facebook", x: "X", twitter: "X", youtube: "YouTube", tiktok: "TikTok" };
    Object.keys(soc).forEach(function (k) {
      links.push(link(soc[k], SOC_LABELS[k.toLowerCase()] || k));
    });
    if (c.merch_url) links.push(link(c.merch_url, "Merch"));
    if (c.donate_url) links.push(link(c.donate_url, "Donate"));
    links = links.filter(Boolean);
    if (links.length) html += section("Links", '<div class="cad-off-links">' + links.join("") + "</div>");

    var aud = (c.auditions && typeof c.auditions === "object") ? c.auditions : {};
    var pos = Array.isArray(c.open_positions) ? c.open_positions.filter(Boolean) : [];
    if (aud.info || aud.link || pos.length) {
      var inner = "";
      if (aud.info) inner += "<p style='margin-top:0'>" + multiline(aud.info) + "</p>";
      if (pos.length) inner += '<div class="cad-off-chips" style="margin-top:8px">' +
        pos.map(function (p) { return '<span class="cad-off-chip">' + esc(p) + "</span>"; }).join("") + "</div>";
      if (aud.link) inner += '<p style="margin-top:8px">' + link(aud.link, "Audition info") + "</p>";
      html += section("Auditions & open positions", inner);
    }

    var anns = Array.isArray(c.announcements) ? c.announcements.slice() : [];
    anns = anns.filter(function (a) { return a && (a.title || a.body); });
    anns.sort(function (a, b) { return String(b.ts || "").localeCompare(String(a.ts || "")); });
    if (anns.length) {
      html += section("Announcements", anns.slice(0, 3).map(function (a) {
        var d = a.ts ? new Date(a.ts) : null;
        var ds = d && !isNaN(d) ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
        return '<div class="cad-off-ann"><b>' + esc(a.title || "Announcement") +
          (ds ? ' <span class="cad-off-ts">· ' + esc(ds) + "</span>" : "") + "</b>" +
          (a.body ? '<span style="color:var(--text-secondary)">' + multiline(a.body) + "</span>" : "") + "</div>";
      }).join(""));
    }

    var vids = Array.isArray(c.videos) ? c.videos.map(function (v) { return link(v, "Watch"); }).filter(Boolean) : [];
    if (vids.length) html += section("Videos", '<div class="cad-off-links">' + vids.join("") + "</div>");

    if (c.alumni) html += section("Alumni", "<p style='margin-top:0'>" + multiline(c.alumni) + "</p>");

    var spons = Array.isArray(c.sponsors) ? c.sponsors : [];
    if (spons.length) {
      html += section("Supporters", '<div class="cad-off-spon">' + spons.map(function (s) {
        var nm = typeof s === "string" ? s : (s && s.name) || "";
        if (!nm) return "";
        var u = (s && typeof s === "object") ? s.url : null;
        var body = safeUrl(u) ? link(u, nm) : esc(nm);
        return '<span><span class="cad-off-sptag">Sponsor</span>' + body + "</span>";
      }).filter(Boolean).join("") + "</div>");
    }

    html += "</div>";
    el.innerHTML = '<div class="cad-off">' + html + "</div>";
  }

  function mountOfficial(el, k, name) {
    if (!el) return Promise.resolve(null);
    return get(k, name).then(function (row) {
      if (row) preview(el, row);
      return row;
    });
  }

  window.CadEnsembles = {
    enabled: !!(cfg && lib),
    get: get,
    mountOfficial: mountOfficial,
    preview: preview,
    claimUrl: claimUrl,
    appKey: appKey,
    appLabel: appLabel,
    rest: rest,
  };
})();
