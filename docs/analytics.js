/* Cadence usage metrics — self-owned, privacy-light. Loaded after supabase.js
   + account.js on every page. Records which screens people actually use so
   product decisions come from data the project owns — no third-party trackers.

   What's collected per event: timestamp, per-tab session id, app, screen,
   coarse device class, PWA-installed flag, and the signed-in user id when one
   exists. No IPs stored by us, no fingerprinting, no cookies.

   The events table is append-only for clients (RLS): nothing can be read
   back from the browser. Owner reads via SQL. */
(function () {
  "use strict";
  var cfg = window.CAD_SUPABASE;
  var lib = window.supabase;
  window.CadMetrics = { track: function () {}, enabled: false };
  if (!cfg || !lib) return;

  var sb = lib.createClient(cfg.url, cfg.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  var SID_KEY = "cad-metrics-sid";
  var sid;
  try {
    sid = sessionStorage.getItem(SID_KEY);
    if (!sid) {
      sid = (crypto.randomUUID && crypto.randomUUID()) ||
        ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, function (c) {
          return (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16);
        });
      sessionStorage.setItem(SID_KEY, sid);
    }
  } catch (e) { return; } // no sessionStorage → skip metrics entirely

  // app identity: family apps carry APP_CFG; the DCI app and standalone pages
  // are inferred from the path
  function appId() {
    if (window.APP_CFG && window.APP_CFG.ns) return window.APP_CFG.ns.replace(/:$/, "");
    var p = location.pathname;
    if (/\/plus\.html$/.test(p)) return "plus";
    if (/\/pro\.html$/.test(p)) return "pro";
    if (/\/modes\.html$/.test(p)) return "modes";
    if (/\/ensemble-admin\.html$/.test(p)) return "ensemble-admin";
    return "dci";
  }
  function screenOf() {
    var h = location.hash || "#/";
    var m = /^#\/([a-z-]*)/.exec(h);
    var seg = (m && m[1]) || "";
    if (!seg) return "scoreboard";
    if (seg === "corps") return /^#\/corps\/./.test(h) ? "corps-detail" : "corps";
    return seg;
  }
  var device = (matchMedia("(pointer: coarse)").matches || innerWidth < 820) ? "mobile" : "desktop";
  var standalone = matchMedia("(display-mode: standalone)").matches || !!navigator.standalone;
  var refHost = null;
  try { refHost = document.referrer ? new URL(document.referrer).host : null; } catch (e) {}
  var sentRef = false;

  var queue = [];
  var flushTimer = null;
  function flush() {
    if (!queue.length) return;
    var batch = queue.splice(0, queue.length);
    sb.from("usage_events").insert(batch).then(function () {}, function () {});
  }
  function push(event, screen, detail) {
    var row = {
      session_id: sid,
      user_id: (window.CadAccount && CadAccount.user() && CadAccount.user().id) || null,
      app: appId(),
      screen: screen,
      event: event,
      detail: detail || null,
      device: device,
      standalone: standalone,
      ref: sentRef ? null : refHost,
    };
    sentRef = true;
    queue.push(row);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 4000);
  }

  var lastScreen = null;
  function view() {
    var s = screenOf();
    if (s === lastScreen) return;
    lastScreen = s;
    push("view", s);
  }
  view();
  addEventListener("hashchange", function () { setTimeout(view, 200); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });

  window.CadMetrics = {
    enabled: true,
    /* record a named action, e.g. CadMetrics.track("share-card", corpsName) */
    track: function (name, detail) { push("action", lastScreen || screenOf(), String(name) + (detail ? ":" + detail : "")); },
  };
})();
