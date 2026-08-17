/* Cadence app registry — the ONE authority for what apps exist.
 *
 * Three modules grew three vocabularies for the same eleven apps (my.js
 * keys, ensembles.js namespace→folder maps, modes.js path sniffing), and
 * they drifted: My Cadence silently ignored six deployed circuits'
 * favorites because its private list never learned they existed. Every
 * fact about an app now lives here once; consumers read it.
 *
 * Loaded before modes.js / my.js / ensembles.js on pages that use them.
 * Modules keep a minimal fallback so a page that forgets the script tag
 * degrades instead of breaking.
 *
 * Fields:
 *   id      canonical id ('dci', 'wgi-guard', 'boa', …)
 *   name    customer-facing name          short  compact chip label
 *   path    folder from the site root ('' = DCI at the root)
 *   ns      APP_CFG.ns / localStorage prefix ('' for DCI)
 *   board   scoreboard shape (trend | event | rating | history)
 *   listed  shown in the app switcher today
 *   status  'live' | 'archive' (real data, not currently ingesting)
 *   term    what a competitor is called, plural
 */
(function () {
  "use strict";
  var APPS = [
    { id: "dci",       name: "DCI",             short: "DCI",    path: "",                ns: "",           board: "trend",   listed: true,  status: "live",    term: "corps" },
    { id: "wgi-guard", name: "WGI Color Guard", short: "WGI CG", path: "wgi/guard/",      ns: "wgi-guard:", board: "history", listed: true,  status: "live",    term: "guards" },
    { id: "wgi-perc",  name: "WGI Percussion",  short: "WGI Pc", path: "wgi/percussion/", ns: "wgi-perc:",  board: "history", listed: true,  status: "live",    term: "ensembles" },
    { id: "wgi-winds", name: "WGI Winds",       short: "WGI Wd", path: "wgi/winds/",      ns: "wgi-winds:", board: "history", listed: true,  status: "live",    term: "ensembles" },
    { id: "boa",       name: "Bands of America", short: "BOA",   path: "boa/",            ns: "boa:",       board: "event",   listed: false, status: "archive", term: "bands" },
    { id: "usbands",   name: "US Bands",        short: "USB",    path: "usbands/",        ns: "usb:",       board: "trend",   listed: false, status: "archive", term: "bands" },
    { id: "uil",       name: "UIL Texas",       short: "UIL",    path: "uil/",            ns: "uil:",       board: "rating",  listed: false, status: "archive", term: "bands" },
    { id: "wgasc",     name: "WGASC",           short: "WGASC",  path: "wgasc/",          ns: "wgasc:",     board: "trend",   listed: false, status: "archive", term: "groups" },
    { id: "tcgc",      name: "TCGC",            short: "TCGC",   path: "tcgc/",           ns: "tcgc:",      board: "trend",   listed: false, status: "archive", term: "groups" },
    { id: "ffcc",      name: "FFCC",            short: "FFCC",   path: "ffcc/",           ns: "ffcc:",      board: "trend",   listed: false, status: "archive", term: "groups" },
  ];

  var byId = {}, byNs = {};
  APPS.forEach(function (a) { byId[a.id] = a; byNs[a.ns] = a; });

  window.CAD_REGISTRY = {
    apps: APPS,
    byId: function (id) { return byId[id] || null; },
    byNs: function (ns) { return byNs[ns] || null; },
    // the app whose folder contains this pathname ('' = DCI root)
    byPath: function (pathname) {
      for (var i = 1; i < APPS.length; i++) {        // most-specific first: skip root
        if (pathname.indexOf("/" + APPS[i].path) >= 0) return APPS[i];
      }
      return APPS[0];
    },
    // claims/profiles folder key ('wgi/guard', 'boa', '' = DCI)
    folderKey: function (a) { return a.path.replace(/\/$/, ""); },
  };
})();
