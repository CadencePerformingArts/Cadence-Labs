/* Cadence+ entitlement core — self-contained. Loaded by any Cadence page that
   needs to know whether this device has Cadence+. It renders nothing by
   itself: it only owns the entitlement record and exposes window.CadPlus for
   pages (plus.html, Settings) to build UI on.

   SANDBOX MODE — no backend exists yet. activate() accepts ANY code shaped
   like CAD-XXXX-XXXX (A–Z / 0–9) and stores it locally, so beta testers and
   the upgrade page can be exercised end to end before real billing lands.
   A real backend (see plus-guide.md) will validate codes / receipts
   server-side later; the public API (active / activate / deactivate /
   features) is designed to survive that swap unchanged. */
(function () {
  "use strict";
  var KEY = "cad-plus"; // localStorage: {"key":"CAD-XXXX-XXXX","since":"<ISO date>"}
  var SHAPE = /^CAD-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var rec = JSON.parse(raw);
      return rec && typeof rec.key === "string" && SHAPE.test(rec.key) ? rec : null;
    } catch (e) { return null; }
  }
  function write(rec) {
    try {
      if (rec) localStorage.setItem(KEY, JSON.stringify(rec));
      else localStorage.removeItem(KEY);
    } catch (e) {}
  }
  function ping() { // let any open UI (Settings, plus.html) re-render
    try {
      window.dispatchEvent(new CustomEvent("cad-plus-change", { detail: { active: !!read() } }));
    } catch (e) {}
  }

  /* What Plus includes — the one list every surface renders from, so the
     upgrade page and a future Settings card can never drift apart. */
  var FEATURES = [
    { id: "captions", icon: "🎼", name: "Caption breakdowns",
      desc: "Judge-by-judge recap breakdowns — GE, visual and music sub-scores for every show." },
    { id: "alerts", icon: "🔔", name: "Fully custom score alerts",
      desc: "Per-caption, per-rival and threshold alerts on your schedule — not just “scores posted.”" },
    { id: "stats", icon: "📈", name: "Advanced stats & caption analysis",
      desc: "Caption-level trends, judge-by-judge recap breakdowns and head-to-head analytics." },
    { id: "compare", icon: "⚖️", name: "Unlimited compare",
      desc: "Compare any number of corps and ensembles, across any seasons, in every Cadence app." },
    { id: "archive", icon: "🗄️", name: "Full historical archive & export",
      desc: "Deep-query every published score back to 1972 and export the database for your own projects." },
    { id: "early", icon: "🚀", name: "Early features",
      desc: "New modes, new tools and new circuits land for Plus members first." },
    { id: "badge", icon: "🎖️", name: "Supporter badge",
      desc: "A badge on your profile — and the warm glow of keeping Cadence independent and ad-free." },
  ];

  /* Pricing lives here — one configurable spot, no numbers hardcoded into
     pages. Presentation only until real billing lands. */
  var PRICING = {
    currency: "$",
    monthly: 1.99,
    annual: 9.99,
    annualNote: "best value",
    /* organization products (docs/pro.html) — presentation only until billing lands */
    ensemblePro: 149,
    eventProMin: 49,
    eventProMax: 199,
  };

  window.CadPlus = {
    /* true when this device holds a Cadence+ entitlement */
    active: function () { return !!read(); },
    pricing: PRICING,
    /* the stored record ({key, since}) or null — handy for Settings UI */
    info: read,
    /* Redeem a code. Returns true and stores the entitlement when the code is
       well-formed; false otherwise. Input is trimmed and uppercased first, so
       "cad-ab12-cd34" works. SANDBOX: shape check only — a real backend
       validates redemption later (plus-guide.md), and this becomes async. */
    activate: function (key) {
      key = String(key || "").trim().toUpperCase();
      if (!SHAPE.test(key)) return false;
      write({ key: key, since: new Date().toISOString() });
      ping();
      return true;
    },
    /* Remove the entitlement from this device (e.g. testing, shared devices). */
    deactivate: function () { write(null); ping(); },
    features: FEATURES,
  };
})();
