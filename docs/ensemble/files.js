/* Cadence Ensemble — file storage helpers, shared by files.html (the digital
   library) and music.html (the music library view of the same data).

   Loaded after core.js. Everything here runs as the SIGNED-IN USER: the
   Storage client is built with that user's access token so uploads, signed
   URLs and deletes are all evaluated by the row-level policies in
   supabase/migrations/0008_ensemble_files.sql. Nothing here can widen what
   the server already allows — the UI checks only exist so people aren't
   shown buttons that would fail.

   PRIVACY: the 'ensemble' bucket is private. This file never builds a public
   object URL. Every download and every preview goes through a short-lived
   signed URL minted on demand and never stored. */
(function () {
  "use strict";
  var cfg = window.CAD_SUPABASE;
  if (!cfg) return;

  var BUCKET = "ensemble";
  var SIGN_SECONDS = 300;          // 5 minutes — long enough to open, short
                                   // enough that a copied link dies fast
  var MAX_OBJECT_BYTES = 524288000; // mirrors the bucket's file_size_limit

  /* ── the user's token, found exactly the way core.js finds it ───────── */
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

  /* ── Storage client. persistSession:false (core.js/account.js own the
     session); the token rides along in the global Authorization header so
     every Storage call is the user's, not anonymous. Rebuilt when the token
     rotates. ─────────────────────────────────────────────────────────── */
  var _client = null, _clientToken = null;
  function client() {
    var t = token();
    if (!window.supabase || !window.supabase.createClient) return null;
    if (_client && _clientToken === t) return _client;
    _clientToken = t;
    _client = window.supabase.createClient(cfg.url, cfg.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: t ? { Authorization: "Bearer " + t } : {} },
    });
    return _client;
  }

  /* ── sizes & quota ─────────────────────────────────────────────────── */
  function fmtSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    var u = ["KB", "MB", "GB", "TB"], i = -1;
    do { n = n / 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 10 || i === 0 ? Math.round(n) : Math.round(n * 10) / 10) + " " + u[i];
  }

  function quota(org) {
    var used = Number(org && org.storage_used_bytes) || 0;
    var total = Number(org && org.storage_quota_bytes) || 0;
    var pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    return {
      used: used, total: total, free: Math.max(0, total - used),
      pct: pct, full: total > 0 && used >= total, nearly: pct >= 90,
      label: fmtSize(used) + " of " + fmtSize(total) + " used",
    };
  }

  /* would this file fit? (the database enforces the same rule) */
  function fits(org, bytes) {
    var q = quota(org);
    if (q.total <= 0) return false;
    return q.used + (Number(bytes) || 0) <= q.total;
  }

  /* ── object keys: <org_id>/<folder_id|root>/<uuid>_<safe name> ─────── */
  /* Storage keys stay ASCII-safe; the human-readable name lives in the row,
     so nothing is lost by scrubbing the key. */
  function safeName(name) {
    var s = String(name == null ? "file" : name);
    try { s = s.normalize("NFKD"); } catch (e) {}
    s = s.replace(/[^A-Za-z0-9.\-_ ]+/g, "-").replace(/\s+/g, "_")
         .replace(/-{2,}/g, "-").replace(/^[-_.]+/, "");
    if (!s) s = "file";
    return s.length > 120 ? s.slice(s.length - 120) : s;
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function pathFor(orgId, folderId, name) {
    return orgId + "/" + (folderId || "root") + "/" + uuid() + "_" + safeName(name);
  }

  function encodePath(p) {
    return String(p).split("/").map(encodeURIComponent).join("/");
  }

  /* ── upload with real progress (XHR — fetch can't report upload bytes) */
  function putObject(path, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var t = token();
      if (!t) { reject(new Error("You're signed out — sign in again to upload.")); return; }
      var xhr = new XMLHttpRequest();
      xhr.open("POST", cfg.url + "/storage/v1/object/" + BUCKET + "/" + encodePath(path), true);
      xhr.setRequestHeader("Authorization", "Bearer " + t);
      xhr.setRequestHeader("apikey", cfg.publishableKey);
      xhr.setRequestHeader("x-upsert", "false");
      if (file.type) xhr.setRequestHeader("Content-Type", file.type);
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(e.loaded / e.total, e.loaded, e.total);
        };
      }
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) { resolve(path); return; }
        var msg = "";
        try { msg = (JSON.parse(xhr.responseText) || {}).message || ""; } catch (e) {}
        if (xhr.status === 403 || /row-level|policy|Unauthor/i.test(msg)) {
          msg = "You don't have permission to upload here.";
        }
        reject(new Error(msg || ("upload failed (" + xhr.status + ")")));
      };
      xhr.onerror = function () { reject(new Error("Network error during upload.")); };
      xhr.onabort = function () { reject(new Error("Upload cancelled.")); };
      if (onProgress) onProgress(0, 0, file.size);
      xhr.send(file);
    });
  }

  async function removeObject(path) {
    var c = client();
    if (c) {
      var r = await c.storage.from(BUCKET).remove([path]);
      if (r.error) throw new Error(r.error.message || "couldn't remove object");
      return true;
    }
    var t = token();
    var res = await fetch(cfg.url + "/storage/v1/object/" + BUCKET + "/" + encodePath(path), {
      method: "DELETE",
      headers: { apikey: cfg.publishableKey, Authorization: "Bearer " + t },
    });
    if (!res.ok) throw new Error("couldn't remove object (" + res.status + ")");
    return true;
  }

  /* ── signed URLs. Never a public URL — always short-lived and per-click */
  async function signedUrl(path, opts) {
    opts = opts || {};
    var seconds = opts.seconds || SIGN_SECONDS;
    var c = client();
    if (c) {
      var r = await c.storage.from(BUCKET).createSignedUrl(path, seconds,
        opts.download ? { download: opts.download } : undefined);
      if (r.error) throw new Error(r.error.message || "couldn't sign that file");
      return r.data.signedUrl;
    }
    var t = token();
    var res = await fetch(cfg.url + "/storage/v1/object/sign/" + BUCKET + "/" + encodePath(path), {
      method: "POST",
      headers: {
        apikey: cfg.publishableKey, Authorization: "Bearer " + t,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: seconds }),
    });
    if (!res.ok) throw new Error("couldn't sign that file (" + res.status + ")");
    var j = await res.json();
    var u = cfg.url + "/storage/v1" + j.signedURL;
    return opts.download ? u + "&download=" + encodeURIComponent(opts.download) : u;
  }

  async function download(row) {
    var url = await signedUrl(row.storage_path, { download: row.name });
    var a = document.createElement("a");
    a.href = url; a.rel = "noopener";
    a.download = row.name || "";
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ── the whole upload: object first, then the row that makes it real.
     If the row is refused (quota, permission), the object is removed again
     so a rejected upload never silently eats the workspace's storage. ── */
  async function uploadFile(org, folderId, file, meta, onProgress) {
    if (!fits(org, file.size)) throw new Error("storage_quota_exceeded");
    if (file.size > MAX_OBJECT_BYTES) {
      throw new Error("That file is larger than the " + fmtSize(MAX_OBJECT_BYTES) + " per-file limit.");
    }
    var member = CadOrg.member();
    var path = pathFor(org.id, folderId, file.name);
    await putObject(path, file, onProgress);
    var body = {
      org_id: org.id,
      folder_id: folderId || null,
      name: file.name,
      storage_path: path,
      mime: file.type || null,
      size_bytes: file.size,
      tags: (meta && meta.tags) || [],
      uploaded_by_member: member ? member.id : null,
    };
    ["instrument", "section", "production", "movement", "season_id", "replaces_file_id", "version"]
      .forEach(function (k) { if (meta && meta[k] != null && meta[k] !== "") body[k] = meta[k]; });
    try {
      var rows = await CadOrg.rest("org_files", {
        method: "POST", headers: { Prefer: "return=representation" }, body: body,
      });
      // reconcile the recorded size against the object that actually landed
      // in the bucket — the client's file.size is only a preflight estimate,
      // and the database refuses direct edits to size_bytes. Best-effort:
      // the estimate stands if the object metadata isn't ready yet.
      CadOrg.rpc("sync_file_size", { p_file: rows[0].id }).catch(function () {});
      // keep the local org object's counter in step with the trigger
      if (org) org.storage_used_bytes = (Number(org.storage_used_bytes) || 0) + file.size;
      return rows[0];
    } catch (err) {
      try { await removeObject(path); } catch (e) {}
      if (/storage_quota_exceeded/.test(err.message || "")) throw new Error("storage_quota_exceeded");
      throw err;
    }
  }

  /* replace a file with a new version: new row, version+1, pointing back */
  async function uploadVersion(org, prev, file, onProgress) {
    return uploadFile(org, prev.folder_id, file, {
      tags: prev.tags || [],
      instrument: prev.instrument, section: prev.section,
      production: prev.production, movement: prev.movement,
      season_id: prev.season_id,
      version: (Number(prev.version) || 1) + 1,
      replaces_file_id: prev.id,
    }, onProgress);
  }

  async function deleteFile(row) {
    // row first: if RLS refuses (no 'file.manage'), the object is untouched
    await CadOrg.rest("org_files?id=eq." + encodeURIComponent(row.id), { method: "DELETE" });
    try { await removeObject(row.storage_path); } catch (e) { CadOrg.log("file.orphaned", "file", row.id); }
    var org = CadOrg.current();
    if (org) org.storage_used_bytes = Math.max(0, (Number(org.storage_used_bytes) || 0) - (Number(row.size_bytes) || 0));
    return true;
  }

  async function renameFile(row, name) {
    var rows = await CadOrg.rest("org_files?id=eq." + encodeURIComponent(row.id), {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: { name: name },
    });
    return rows && rows[0];
  }

  /* ── folder trees ──────────────────────────────────────────────────── */
  function buildTree(folders) {
    var byId = {}, roots = [], kids = {};
    (folders || []).forEach(function (f) { byId[f.id] = f; kids[f.id] = []; });
    (folders || []).forEach(function (f) {
      if (f.parent_id && kids[f.parent_id]) kids[f.parent_id].push(f);
      else roots.push(f);
    });
    function sort(list) {
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
      list.forEach(function (f) { sort(kids[f.id]); });
    }
    sort(roots);
    return { byId: byId, roots: roots, children: function (id) { return (id ? kids[id] : roots) || []; } };
  }

  function crumbs(tree, id) {
    var out = [], cur = id, hops = 0;
    while (cur && tree.byId[cur] && hops < 24) {
      out.unshift(tree.byId[cur]);
      cur = tree.byId[cur].parent_id;
      hops++;
    }
    return out;
  }

  /* every descendant of a folder, inclusive — used by "this folder and below" */
  function subtreeIds(tree, id) {
    var out = [], stack = [id];
    while (stack.length) {
      var cur = stack.pop();
      if (cur) out.push(cur);
      tree.children(cur).forEach(function (f) { stack.push(f.id); });
    }
    return out;
  }

  /* ── previewing ────────────────────────────────────────────────────── */
  function kindOf(row) {
    var m = (row.mime || "").toLowerCase();
    var n = (row.name || "").toLowerCase();
    if (m.indexOf("pdf") >= 0 || /\.pdf$/.test(n)) return "pdf";
    if (m.indexOf("image/") === 0 || /\.(png|jpe?g|gif|webp|svg|heic)$/.test(n)) return "image";
    if (m.indexOf("audio/") === 0 || /\.(mp3|m4a|wav|aac|ogg|flac)$/.test(n)) return "audio";
    if (m.indexOf("video/") === 0 || /\.(mp4|mov|m4v|webm|avi)$/.test(n)) return "video";
    return "other";
  }

  function iconFor(row) {
    return { pdf: "<svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true' style='vertical-align:-3px'><path d='M6 3h8l4 4v14H6zM14 3v4h4'/></svg>", image: "<svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true' style='vertical-align:-3px'><path d='M4 5h16v14H4zM4 15l4.5-4.5L13 15M14.5 13l2-2L20 14.5M9 9.2h.01'/></svg>", audio: "<svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true' style='vertical-align:-3px'><path d='M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H4zM17 14h3v6h-3z'/></svg>", video: "<svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true' style='vertical-align:-3px'><path d='M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4'/></svg>", other: "<svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true' style='vertical-align:-3px'><path d='M8 12.5 15 5.5a3 3 0 0 1 4.2 4.2l-8.5 8.5a5 5 0 0 1-7-7l8-8'/></svg>" }[kindOf(row)];
  }

  /* the inline viewer body for an already-signed URL */
  function previewHtml(row, url) {
    var k = kindOf(row), safe = CadOrg.esc(url), name = CadOrg.esc(row.name);
    if (k === "pdf") {
      return '<object class="fl-view" data="' + safe + '" type="application/pdf">' +
        '<embed class="fl-view" src="' + safe + '" type="application/pdf">' +
        '<p class="setnote">Your browser can\'t show PDFs inline. ' +
        '<a href="' + safe + '" target="_blank" rel="noopener">Open ' + name + " →</a></p></object>";
    }
    if (k === "image") return '<img class="fl-view fl-img" src="' + safe + '" alt="' + name + '">';
    if (k === "audio") return '<audio class="fl-audio" src="' + safe + '" controls preload="metadata"></audio>';
    if (k === "video") return '<video class="fl-view" src="' + safe + '" controls preload="metadata"></video>';
    return '<div class="empty">No inline preview for this kind of file — ' +
      '<a href="' + safe + '" target="_blank" rel="noopener">open or download it</a> instead.</div>';
  }

  /* full-screen preview sheet. Signs on open; the URL is never persisted. */
  async function openPreview(row) {
    var wrap = document.createElement("div");
    wrap.className = "fl-modal";
    wrap.innerHTML = '<div class="fl-modal-in"><div class="fl-modal-top">' +
      "<b>" + CadOrg.esc(row.name) + "</b>" +
      '<button class="tab" data-x="1" type="button">Close</button></div>' +
      '<div class="fl-modal-body"><div class="loading">Opening…</div></div>' +
      '<div class="fl-modal-foot"><span class="setsub">' + CadOrg.esc(fmtSize(row.size_bytes)) +
      (row.instrument ? " · " + CadOrg.esc(row.instrument) : "") +
      (row.production ? " · " + CadOrg.esc(row.production) : "") +
      '</span><button class="tab" data-dl="1" type="button">Download</button></div></div>';
    document.body.appendChild(wrap);
    function close() { wrap.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || (e.target.dataset && e.target.dataset.x)) { close(); return; }
      if (e.target.dataset && e.target.dataset.dl) download(row).catch(function () {});
    });
    var body = wrap.querySelector(".fl-modal-body");
    try {
      var url = await signedUrl(row.storage_path, { seconds: 900 });
      body.innerHTML = previewHtml(row, url);
    } catch (err) {
      body.innerHTML = '<div class="empty">Couldn\'t open that file — ' +
        CadOrg.esc(err.message || "unknown error") + "</div>";
    }
    return close;
  }

  /* ── odds and ends ─────────────────────────────────────────────────── */
  function relTime(iso) {
    if (!iso) return "";
    var d = new Date(iso), ms = Date.now() - d.getTime();
    if (ms < 0) return d.toLocaleDateString();
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + "d ago";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function parseTags(s) {
    return String(s || "").split(",").map(function (t) { return t.trim().toLowerCase(); })
      .filter(function (t) { return t.length > 0 && t.length <= 40; })
      .filter(function (t, i, a) { return a.indexOf(t) === i; })
      .slice(0, 12);
  }

  function allTags(rows) {
    var seen = {};
    (rows || []).forEach(function (r) {
      (r.tags || []).forEach(function (t) { seen[t] = (seen[t] || 0) + 1; });
    });
    return Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a] || a.localeCompare(b); });
  }

  function matches(row, q) {
    if (!q) return true;
    var hay = [row.name, (row.tags || []).join(" "), row.instrument, row.section,
               row.production, row.movement].join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
  }

  var FOLDER_KINDS = [
    ["general", "General"], ["music", "Music"], ["audio", "Audio / practice tracks"],
    ["video", "Video"], ["visual", "Visual / drill"], ["admin", "Admin"],
    ["travel", "Travel"], ["staff", "Staff only"], ["booster", "Boosters"],
  ];
  var ROLE_KINDS = [
    ["owner", "Owners"], ["staff", "Staff"], ["leadership", "Leadership"],
    ["member", "Members"], ["parent", "Parents"], ["booster", "Boosters"],
    ["volunteer", "Volunteers"], ["alumni", "Alumni"], ["guest", "Guests"],
  ];

  window.CadFiles = {
    BUCKET: BUCKET, FOLDER_KINDS: FOLDER_KINDS, ROLE_KINDS: ROLE_KINDS,
    MAX_OBJECT_BYTES: MAX_OBJECT_BYTES,
    client: client, token: token,
    fmtSize: fmtSize, quota: quota, fits: fits,
    pathFor: pathFor, safeName: safeName,
    uploadFile: uploadFile, uploadVersion: uploadVersion,
    deleteFile: deleteFile, renameFile: renameFile,
    removeObject: removeObject, signedUrl: signedUrl, download: download,
    buildTree: buildTree, crumbs: crumbs, subtreeIds: subtreeIds,
    kindOf: kindOf, iconFor: iconFor, previewHtml: previewHtml, openPreview: openPreview,
    relTime: relTime, parseTags: parseTags, allTags: allTags, matches: matches,
  };
})();
