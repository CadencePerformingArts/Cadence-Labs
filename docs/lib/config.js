/* Cadence runtime configuration — the single place the app learns its own
   public URL, the push/ask relay, and feature switches. Everything else reads
   window.CadConfig so a future custom-domain move (or relay move) is a
   one-file change. Consumers must degrade gracefully if this file failed to
   load: read via (window.CadConfig || {}) and treat missing values as "off". */
(function () {
  "use strict";
  window.CadConfig = {
    // Public base URL of the deployed app. Used for share-card links, social
    // text, and anywhere an absolute link leaves the app. Trailing slash.
    BASE_URL: "https://cadenceperformingarts.github.io/Cadence-Labs/",
    // Short human label for the same URL (printed on share images).
    BASE_LABEL: "cadenceperformingarts.github.io/Cadence-Labs",
    // Push/ask relay origin (no trailing slash). Empty string disables every
    // relay-backed feature (score alerts UI degrades with a clear message).
    RELAY_URL: "https://cadenceapp.up.railway.app",
    // The scores assistant. Mirrors the relay's own server-side gate — turning
    // this on without the relay's ASK_ENABLED + API key still yields a polite
    // "unavailable" from the server. Keep false until the owner enables both.
    ASK_ENABLED: false,
    // Release identifier shown on the About page; keep in step with the
    // service worker's cache version when shell files change.
    RELEASE: "v42",
  };
})();
