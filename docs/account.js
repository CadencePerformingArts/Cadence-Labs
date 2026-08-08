/* Cadence accounts — one sign-in for every Cadence app. Loaded before the
   app engine on every page (after vendor/supabase.min.js + supabase.js).

   What it does when signed in:
   - mirrors favorites and alert/theme preferences to the user's account the
     moment they change (the apps keep writing localStorage exactly as they
     always have — a thin Storage wrapper watches the keys that matter);
   - pulls the account's preferences down on sign-in / page load, so a second
     device looks like the first within one refresh;
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

  // no-op surface when the accounts backend isn't wired on this page
  window.CadAccount = {
    enabled: !!(cfg && lib),
    user: function () { return state.user; },
    plusStatus: function () { return state.plus; },
    ready: function () { return state.ready; },
    signIn: function () { return Promise.reject(new Error("accounts not configured")); },
    signOut: function () {},
    onChange: function (fn) { listeners.push(fn); },
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

  function queuePush(key) {
    if (applying || !state.user || !SYNC_RE.test(key)) return;
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
    var upserts = [], removes = [];
    keys.forEach(function (k) {
      var v = null;
      try { v = window.localStorage.getItem(k); } catch (e) {}
      if (v == null) removes.push(k);
      else upserts.push({ user_id: uid, key: k, value: { v: v } });
    });
    try {
      if (upserts.length) await sb.from("preferences").upsert(upserts);
      if (removes.length) await sb.from("preferences").delete().eq("user_id", uid).in("key", removes);
      // favorites also live as real rows, so future score alerts can target
      // "only my favorites" server-side
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!/(^|:)cad-favs$/.test(k)) continue;
        var ns = favNs(k), names = [];
        try { names = JSON.parse(window.localStorage.getItem(k) || "[]") || []; } catch (e) {}
        await sb.from("favorites").delete().eq("user_id", uid).eq("app_ns", ns);
        if (names.length) {
          await sb.from("favorites").insert(names.map(function (n) {
            return { user_id: uid, app_ns: ns, name: String(n) };
          }));
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
    var server = {};
    (res.data || []).forEach(function (r) { server[r.key] = (r.value && r.value.v != null) ? String(r.value.v) : null; });

    var needReload = false;
    applying = true;
    try {
      Object.keys(server).forEach(function (k) {
        if (server[k] == null) return;
        var local = null;
        try { local = window.localStorage.getItem(k); } catch (e) {}
        if (/(^|:)cad-favs$/.test(k) && local) {
          // favorites merge as a union — no device ever loses a star
          var a = [], b = [];
          try { a = JSON.parse(local) || []; } catch (e) {}
          try { b = JSON.parse(server[k]) || []; } catch (e) {}
          var merged = a.slice();
          b.forEach(function (n) { if (merged.indexOf(n) < 0) merged.push(n); });
          var out = JSON.stringify(merged);
          if (out !== local) rawSet.call(window.localStorage, k, out);
          if (out !== server[k]) dirty[k] = true;
          return;
        }
        if (local !== server[k]) {
          rawSet.call(window.localStorage, k, server[k]);
          if (RELOAD_RE.test(k)) needReload = true;
        }
      });
      // anything set locally that the account doesn't know yet goes up
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
