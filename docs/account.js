/* Cadence accounts — one sign-in for every Cadence app. Loaded before the
   app engine on every page (after vendor/supabase.min.js + supabase.js).

   What it does when signed in:
   - mirrors favorites and alert/theme preferences to the user's account the
     moment they change (the apps keep writing localStorage exactly as they
     always have — a thin Storage wrapper watches the keys that matter);
   - pulls the account's preferences down on sign-in / page load, so a second
     device looks like the first within one refresh. Conflicts resolve
     last-writer-wins on a per-key write time, and deletions are tombstones
     rather than row-deletes so un-starring a corps or resetting a setting
     propagates everywhere instead of resurrecting;
   - exposes window.CadAccount for the Settings card (user, signIn, signOut,
     onChange, plusStatus).

   Without the Supabase lib or config present it quietly no-ops: every page
   keeps working exactly as a signed-out page. */
(function () {
  "use strict";
  var cfg = window.CAD_SUPABASE;
  var lib = window.supabase;
  var listeners = [];
  var state = { user: null, plus: null, ready: false, syncedAt: null };

  function emit() {
    listeners.forEach(function (fn) { try { fn(state); } catch (e) {} });
    try { window.dispatchEvent(new CustomEvent("cad-account-change")) } catch (e) {}
  }

  /* ---- last-writer-wins sync, the one rule both directions follow ----
     Every synced key carries a write time. The server stores {v, t} for a
     value and {del: 1, t} as a TOMBSTONE for a deletion — deletions are
     never plain row-deletes, because a device that missed the deletion
     would see "server doesn't know this key" and push its stale copy back
     (the resurrection bug). Given both sides' state, exactly one of four
     things happens; pure so the table is unit-testable (test_sync_merge.js):

       serverHas  sv        outcome
       ────────── ───────── ─────────────────────────────────────────────
       no         —         'push-local'    (never synced — goes up)
       yes        null      st >= lt ? 'remove-local' : 'push-local'
       yes        value     sv === lv ? 'noop'
                            : st >= lt ? 'apply-server' : 'push-local'

     Ties go to the server (deterministic across devices; legacy rows with
     no t compare as 0). */
  function lwwDecide(serverHas, sv, st, lv, lt) {
    st = st || 0; lt = lt || 0;
    if (!serverHas) return lv == null ? "noop" : "push-local";
    if (sv == null) {                       // tombstone
      if (lv == null) return "noop";
      return st >= lt ? "remove-local" : "push-local";
    }
    if (sv === lv) return "noop";
    return st >= lt ? "apply-server" : "push-local";
  }

  // no-op surface when the accounts backend isn't wired on this page
  window.CadAccount = {
    enabled: !!(cfg && lib),
    user: function () { return state.user; },
    plusStatus: function () { return state.plus; },
    ready: function () { return state.ready; },
    signIn: function () { return Promise.reject(new Error("accounts not configured")); },
    signOut: function () {},
    onChange: function (fn) { listeners.push(fn); },
    _lww: lwwDecide,
  };
  if (!cfg || !lib) return;

  var sb = lib.createClient(cfg.url, cfg.publishableKey, {
    auth: { flowType: "pkce", detectSessionInUrl: true },
  });

  /* ---- which localStorage keys follow the account ---- */
  // matches bare DCI keys ("cad-favs") and namespaced family keys
  // ("wgi-perc:cad-favs") — everything preference-like, nothing transient
  var SYNC_RE = /(^|:)cad-(favs|notify-on|notify-scope|notify-classes|notify-preds|theme|fontsize|corps-theme|corps-css|plus)$/;
  // theme keys need the boot script, so a pull that changes them reloads once
  var RELOAD_RE = /(^|:)cad-(theme|fontsize|corps-theme|corps-css)$/;

  var applying = false;   // true while applying server rows locally (no echo)
  var pushTimer = null;
  var dirty = {};         // key -> true

  /* per-key local write times, the "lt" side of lwwDecide. Device-local
     bookkeeping — deliberately NOT a synced key itself. */
  var META_KEY = "cad-sync-t";
  function metaMap() {
    try { return JSON.parse(window.localStorage.getItem(META_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function metaSet(k, t) {
    var m = metaMap();
    m[k] = t;
    try { rawSet.call(window.localStorage, META_KEY, JSON.stringify(m)); } catch (e) {}
  }

  function queuePush(key) {
    if (applying || !SYNC_RE.test(key)) return;
    metaSet(key, Date.now());           // stamp even signed out — an eventual
    if (!state.user) return;            // sign-in pushes with honest times
    dirty[key] = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushDirty, 1200);
  }

  // watch the apps' ordinary localStorage writes — they don't know we exist
  var rawSet = Storage.prototype.setItem;
  var rawRemove = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) {
    rawSet.call(this, k, v);
    if (this === window.localStorage) queuePush(k);
  };
  Storage.prototype.removeItem = function (k) {
    rawRemove.call(this, k);
    if (this === window.localStorage) queuePush(k);
  };

  function favNs(key) { // "wgi-perc:cad-favs" -> "wgi-perc:", "cad-favs" -> ""
    return key.slice(0, key.length - "cad-favs".length);
  }

  async function pushDirty() {
    if (!state.user) return;
    var keys = Object.keys(dirty);
    dirty = {};
    if (!keys.length) return;
    var uid = state.user.id;
    var meta = metaMap();
    // a deleted key becomes a TOMBSTONE row ({del,t}), never a row-delete —
    // deleting the row would make other devices push their stale copy back
    var upserts = keys.map(function (k) {
      var v = null;
      try { v = window.localStorage.getItem(k); } catch (e) {}
      var t = meta[k] || Date.now();
      return v == null
        ? { user_id: uid, key: k, value: { del: 1, t: t } }
        : { user_id: uid, key: k, value: { v: v, t: t } };
    });
    try {
      if (upserts.length) await sb.from("preferences").upsert(upserts);
      // favorites also live as real rows, so future score alerts can target
      // "only my favorites" server-side. Upsert-then-prune: the account never
      // passes through an empty state mid-update, and a crash between the two
      // calls leaves extras (pruned next push), never lost stars.
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!/(^|:)cad-favs$/.test(k)) continue;
        var ns = favNs(k), names = [];
        try { names = JSON.parse(window.localStorage.getItem(k) || "[]") || []; } catch (e) {}
        names = names.map(function (n) { return String(n); });
        if (names.length) {
          await sb.from("favorites").upsert(names.map(function (n) {
            return { user_id: uid, app_ns: ns, name: n };
          }));
          await sb.from("favorites").delete().eq("user_id", uid).eq("app_ns", ns)
            .not("name", "in", "(" + names.map(function (n) {
              return '"' + n.replace(/"/g, '\\"') + '"';
            }).join(",") + ")");
        } else {
          await sb.from("favorites").delete().eq("user_id", uid).eq("app_ns", ns);
        }
      }
      state.syncedAt = new Date();
      emit();
    } catch (e) { /* offline or RLS hiccup — the next change retries */ }
  }

  async function pull() {
    if (!state.user) return;
    var res = await sb.from("preferences").select("key,value");
    if (res.error) return;
    // server rows: {v,t} = value, {del,t} = tombstone, legacy {v} = t 0
    var server = {};
    (res.data || []).forEach(function (r) {
      var val = r.value || {};
      server[r.key] = { v: val.v != null ? String(val.v) : null, t: +val.t || 0 };
    });

    var meta = metaMap();
    var needReload = false;
    applying = true;
    try {
      Object.keys(server).forEach(function (k) {
        var local = null;
        try { local = window.localStorage.getItem(k); } catch (e) {}
        var d = lwwDecide(true, server[k].v, server[k].t, local, meta[k] || 0);
        if (d === "apply-server") {
          rawSet.call(window.localStorage, k, server[k].v);
          metaSet(k, server[k].t);
          if (RELOAD_RE.test(k)) needReload = true;
        } else if (d === "remove-local") {
          rawRemove.call(window.localStorage, k);
          metaSet(k, server[k].t);
          if (RELOAD_RE.test(k)) needReload = true;
        } else if (d === "push-local") {
          dirty[k] = true;
        }
      });
      // anything set locally that the account has never seen goes up. (A key
      // the account HAS seen is in `server` — as a value or a tombstone — so
      // this no longer resurrects deletions the way the old row-delete did.)
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (SYNC_RE.test(k) && !(k in server)) dirty[k] = true;
      }
    } finally { applying = false; }

    if (Object.keys(dirty).length) { clearTimeout(pushTimer); pushTimer = setTimeout(pushDirty, 300); }
    state.syncedAt = new Date();
    emit();
    if (needReload && !sessionStorage.getItem("cad-acct-reloaded")) {
      try { sessionStorage.setItem("cad-acct-reloaded", "1"); } catch (e) {}
      location.reload();
    }
  }

  async function loadPlus() {
    try {
      var res = await sb.from("plus_entitlements").select("status,since").maybeSingle();
      state.plus = res.data || null;
    } catch (e) { state.plus = null; }
  }

  window.CadAccount = {
    enabled: true,
    user: function () { return state.user; },
    plusStatus: function () { return state.plus; },
    syncedAt: function () { return state.syncedAt; },
    ready: function () { return state.ready; },
    /* email magic-link sign-in; resolves when the email is on its way */
    signIn: function (email) {
      return sb.auth.signInWithOtp({
        email: String(email || "").trim(),
        options: { emailRedirectTo: location.origin + location.pathname },
      }).then(function (res) {
        if (res.error) throw res.error;
        return true;
      });
    },
    signOut: function () { return sb.auth.signOut(); },
    onChange: function (fn) { listeners.push(fn); },
  };

  sb.auth.onAuthStateChange(function (_event, session) {
    var was = state.user && state.user.id;
    state.user = session ? session.user : null;
    state.ready = true;
    var now = state.user && state.user.id;
    emit();
    if (now && now !== was) { pull(); loadPlus(); }
    if (!now) { state.plus = null; try { sessionStorage.removeItem("cad-acct-reloaded"); } catch (e) {} }
  });
})();
