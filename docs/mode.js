/* Cadence has two audiences and they want different things:

     FAN     — follows DCI and WGI scores, standings and history
     MEMBER  — is in a band or guard and lives in their workspace

   Rather than make everyone navigate past the half they don't use, each
   person picks the side they mostly want. That choice decides where the app
   opens; a switch in the top bar flips it any time, so nobody is ever stuck
   in the wrong half.

   Loaded on every page, next to modes.js. Owns nothing else. */
(function () {
  "use strict";
  var script = document.currentScript;
  var base = (script && script.getAttribute("data-base")) || ".";
  var KEY = "cad-mode";            // "fan" | "member" (synced with the account)
  var ROUTED = "cad-mode-routed";  // once per tab, so back-navigation still works

  function get() {
    try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; }
  }
  function set(m) {
    try { localStorage.setItem(KEY, m); } catch (e) {}
  }
  var inWorkspace = /\/ensemble\//.test(location.pathname);

  function go(m) {
    set(m);
    var target = m === "member" ? base + "/ensemble/" : base + "/";
    try { sessionStorage.setItem(ROUTED, "1"); } catch (e) {}
    location.href = target;
  }

  /* ── the switch itself: two segments in the top bar ──────────────────── */
  var css = [
    ".cad-mode{display:inline-flex;align-items:center;gap:2px;margin-left:auto;",
    "background:rgba(255,255,255,.12);border-radius:999px;padding:2px}",
    ".cad-mode button{border:0;background:none;cursor:pointer;font:inherit;",
    "color:rgba(255,255,255,.78);font-size:12.5px;font-weight:700;",
    "padding:5px 12px;border-radius:999px;white-space:nowrap;line-height:1.3}",
    ".cad-mode button.on{background:var(--gold,#f0b429);color:var(--navy,#0a3f6b)}",
    ".cad-mode button:not(.on):hover{color:#fff}",
    "@media (max-width:520px){.cad-mode button{padding:5px 9px;font-size:11.5px}}",
    /* first-run chooser */
    ".cad-pick{background:var(--surface-1,#fff);border-bottom:1px solid var(--border,#dfe4ec);",
    "padding:14px 18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:center}",
    ".cad-pick p{margin:0;font-size:14px;color:var(--text-secondary,#3f4c63);font-weight:600}",
    ".cad-pick .cad-pick-btns{display:flex;gap:8px;flex-wrap:wrap}",
    ".cad-pick button{border:1px solid var(--border,#dfe4ec);background:var(--surface-1,#fff);",
    "color:var(--text-primary,#16233d);font:inherit;font-size:13.5px;font-weight:700;",
    "padding:8px 16px;border-radius:10px;cursor:pointer}",
    ".cad-pick button:hover{border-color:var(--baseline,#c4cdda);background:var(--surface-2,#eef1f6)}",
    ".cad-pick .cad-pick-skip{border:0;background:none;color:var(--muted,#74808f);font-weight:600}",
  ].join("");
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  function mountSwitch() {
    var bar = document.querySelector(".topbar");
    if (!bar || bar.querySelector(".cad-mode")) return;
    var cur = inWorkspace ? "member" : "fan";
    var wrap = document.createElement("div");
    wrap.className = "cad-mode";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Switch between scores and your group");
    wrap.innerHTML =
      '<button type="button" data-m="fan"' + (cur === "fan" ? ' class="on"' : "") +
        ' aria-pressed="' + (cur === "fan") + '">Scores</button>' +
      '<button type="button" data-m="member"' + (cur === "member" ? ' class="on"' : "") +
        ' aria-pressed="' + (cur === "member") + '">My group</button>';
    wrap.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-m]");
      if (!b) return;
      var m = b.dataset.m;
      if (m === cur) { set(m); return; } // already here — just make it the default
      go(m);
    });
    // the updated/status chip likes to sit at the right; keep it last
    var updated = bar.querySelector(".updated");
    if (updated) bar.insertBefore(wrap, updated); else bar.appendChild(wrap);
  }

  /* ── first visit: ask once, in place, without blocking anything ─────── */
  function mountChooser() {
    if (get() || inWorkspace) return;
    var bar = document.querySelector(".topbar");
    if (!bar) return;
    var box = document.createElement("div");
    box.className = "cad-pick";
    box.innerHTML =
      "<p>What brings you to Cadence?</p>" +
      '<span class="cad-pick-btns">' +
      '<button type="button" data-pick="fan">I follow scores</button>' +
      '<button type="button" data-pick="member">I\'m in a group</button>' +
      '<button type="button" class="cad-pick-skip" data-pick="skip">Not now</button></span>';
    box.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-pick]");
      if (!b) return;
      var p = b.dataset.pick;
      if (p === "skip") { set("fan"); box.remove(); return; }
      if (p === "fan") { set("fan"); box.remove(); mountSwitch(); return; }
      go("member");
    });
    bar.insertAdjacentElement("afterend", box);
  }

  /* ── open where they asked to open ──────────────────────────────────── */
  function routeHome() {
    if (get() !== "member" || inWorkspace) return;
    var p = location.pathname.replace(/index\.html$/, "");
    var root = (base === "." ? location.pathname.replace(/[^/]*$/, "") : null);
    var atRoot = root !== null && p === root;
    if (!atRoot) return;                       // only the front door redirects
    if (location.hash && location.hash !== "#/") return;  // deep link wins
    try { if (sessionStorage.getItem(ROUTED)) return; } catch (e) {}
    try { sessionStorage.setItem(ROUTED, "1"); } catch (e) {}
    location.replace(base + "/ensemble/");
  }

  window.CadMode = { get: get, set: set, switchTo: go, mount: mountSwitch };

  function boot() { routeHome(); mountSwitch(); mountChooser(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
