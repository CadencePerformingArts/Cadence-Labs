/* First-visit starter hint — the fan's first 30 seconds.
 *
 * One slim, dismissible strip under the top bar that explains the single
 * action that personalizes everything: starring a corps. Shows only when
 * ALL of these hold, so it never nags and never stacks:
 *   - no favorites yet (a favorite is the point of the hint)
 *   - never dismissed
 *   - the mode chooser ("What brings you to Cadence?") is not on screen —
 *     one question at a time for a brand-new visitor
 *
 * Standalone on purpose: no app.js edits, so the derived family engine is
 * untouched. Loaded on the DCI page only — the front door.
 */
(function () {
  "use strict";
  var KEY = "cad-starter-done";

  function favs() {
    try { return JSON.parse(localStorage.getItem("cad-favs") || "[]") || []; }
    catch (e) { return []; }
  }
  function done() {
    try { return !!localStorage.getItem(KEY); } catch (e) { return false; }
  }
  function markDone() {
    try { localStorage.setItem(KEY, "1"); } catch (e) {}
  }

  function boot() {
    if (done()) return;
    if (favs().length) { markDone(); return; }   // they already found the star
    if (document.querySelector(".cad-pick")) return;  // chooser is up — not now
    var bar = document.querySelector("header.topbar");
    if (!bar) return;

    var strip = document.createElement("div");
    strip.className = "cad-starter";
    strip.innerHTML =
      '<style>.cad-starter{display:flex;gap:10px;align-items:center;flex-wrap:wrap;' +
      "background:var(--accent-wash,#fdf3dd);color:var(--accent-ink,#7a5200);" +
      "border-bottom:1px solid var(--border,#dfe4ec);padding:9px 16px;font-size:13.5px;font-weight:600}" +
      ".cad-starter svg{flex:none}" +
      ".cad-starter a{color:inherit;text-decoration:underline}" +
      ".cad-starter button{margin-left:auto;border:0;background:none;color:inherit;" +
      "font:inherit;font-weight:700;cursor:pointer;padding:4px 8px;border-radius:8px}" +
      ".cad-starter button:hover{background:rgba(0,0,0,.06)}</style>" +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z"/></svg>' +
      "<span>New here? Star a corps on <a href=\"#/corps\">its page</a> — favorites drive " +
      "your standings highlights, show filters and score alerts.</span>" +
      '<button type="button" aria-label="Dismiss">Got it</button>';
    strip.querySelector("button").addEventListener("click", function () {
      markDone();
      strip.remove();
    });
    bar.insertAdjacentElement("afterend", strip);

    // starring anything anywhere retires the hint for good
    var iv = setInterval(function () {
      if (favs().length || done()) {
        markDone();
        if (strip.isConnected) strip.remove();
        clearInterval(iv);
      }
    }, 4000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
