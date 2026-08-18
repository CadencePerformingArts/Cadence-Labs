/* Cadence — "Add to Home Screen" helper.
   Makes installing the PWA obvious (iOS has no native install prompt, so people
   can't find it), and occasionally nudges visitors who haven't installed yet.
   Detects standalone so it never nags anyone who already added it.
   Namespaced (.in-* / cad-install-* localStorage / window.CadInstall) and
   reuses the app's CSS variables, so it follows the chosen light/dark theme. */
(function () {
  "use strict";
  var UA = navigator.userAgent || "";
  // iPadOS 13+ masquerades as a Mac — the touch-point check catches it
  var isIOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // on iOS only Safari can Add to Home Screen; other browsers are WebKit but blocked
  var iosSafari = isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA|DuckDuckGo/.test(UA);
  var isAndroid = /Android/.test(UA);

  function standalone() {
    try { return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; }
    catch (e) { return false; }
  }
  function lget(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function nativePrompt() { return window.__cadInstallEvent || null; }

  var ICON = "icons/icon-192.png";
  var SHARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M6 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1"/></svg>';
  var PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M12 8.5v7M8.5 12h7"/></svg>';

  function injectStyles() {
    if (document.getElementById("in-style")) return;
    var css = [
      ".in-ov{position:fixed;inset:0;z-index:3400;display:flex;align-items:flex-end;justify-content:center;}",
      ".in-back{position:absolute;inset:0;background:rgba(6,10,18,.55);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);}",
      ".in-sheet{position:relative;z-index:2;width:100%;max-width:470px;background:var(--surface-1);color:var(--text-primary);border:1px solid var(--border);border-bottom:0;border-radius:22px 22px 0 0;box-shadow:0 -12px 44px rgba(6,10,18,.5);padding:18px 20px calc(20px + env(safe-area-inset-bottom,0px));animation:in-up .3s cubic-bezier(.2,.9,.3,1.12) both;}",
      "@keyframes in-up{from{opacity:0;transform:translateY(26px);}to{opacity:1;transform:none;}}",
      "@media (min-width:520px){.in-ov{align-items:center;}.in-sheet{border:1px solid var(--border);border-radius:22px;}}",
      "@media (prefers-reduced-motion: reduce){.in-sheet{animation:none;}}",
      ".in-grab{width:38px;height:4px;border-radius:2px;background:var(--baseline);margin:2px auto 12px;}",
      ".in-head{display:flex;align-items:center;gap:13px;}",
      ".in-icon{width:52px;height:52px;border-radius:13px;flex:0 0 auto;box-shadow:0 3px 10px rgba(0,0,0,.22);}",
      ".in-htext{min-width:0;}",
      ".in-title{font-size:18px;font-weight:800;letter-spacing:-.2px;color:var(--text-primary);}",
      ".in-sub{font-size:12.5px;color:var(--muted);margin-top:2px;line-height:1.4;}",
      ".in-x{position:absolute;top:12px;right:12px;width:32px;height:32px;border:0;border-radius:50%;background:var(--surface-2);color:var(--text-secondary);font-size:19px;line-height:1;cursor:pointer;display:grid;place-items:center;}",
      ".in-x:hover{color:var(--text-primary);}",
      ".in-steps{list-style:none;margin:16px 0 4px;padding:0;display:flex;flex-direction:column;gap:11px;}",
      ".in-step{display:flex;align-items:center;gap:12px;background:var(--surface-2);border:1px solid var(--border);border-radius:13px;padding:11px 13px;}",
      ".in-num{flex:0 0 24px;height:24px;border-radius:50%;background:var(--gold);color:#16233d;font-weight:800;font-size:13px;display:grid;place-items:center;}",
      ".in-stext{font-size:14.5px;line-height:1.35;color:var(--text-primary);}",
      ".in-stext b{font-weight:800;}",
      ".in-gly{display:inline-flex;vertical-align:-5px;width:19px;height:19px;color:var(--link);margin:0 2px;}",
      ".in-gly svg{width:19px;height:19px;}",
      ".in-install{display:block;width:100%;border:0;border-radius:13px;padding:14px;margin-top:14px;font:inherit;font-size:16px;font-weight:800;cursor:pointer;background:var(--gold);color:#16233d;}",
      ".in-install:hover{filter:brightness(1.04);}",
      ".in-note{font-size:12.5px;color:var(--muted);text-align:center;margin-top:12px;line-height:1.5;}",
      ".in-hint{display:flex;align-items:center;justify-content:center;gap:7px;font-size:13px;font-weight:700;color:var(--link);margin-top:14px;}",
      ".in-hint .in-gly{color:var(--link);}",
      ".in-actions{display:flex;gap:10px;margin-top:14px;}",
      ".in-later{flex:1;border:1px solid var(--border);background:var(--surface-2);color:var(--text-primary);border-radius:11px;padding:11px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;}",
      ".in-later:hover{border-color:var(--muted);}",
      ".in-never{background:none;border:0;color:var(--muted);font:inherit;font-size:12.5px;cursor:pointer;text-decoration:underline;padding:6px;display:block;margin:8px auto 0;}"
    ].join("\n");
    var st = document.createElement("style"); st.id = "in-style"; st.textContent = css;
    document.head.appendChild(st);
  }

  function stepsHtml() {
    var s = function (n, html) { return '<li class="in-step"><span class="in-num">' + n + '</span><span class="in-stext">' + html + "</span></li>"; };
    if (iosSafari) {
      return '<ul class="in-steps">' +
        s(1, 'Tap the <span class="in-gly">' + SHARE + "</span> <b>Share</b> button in Safari’s toolbar") +
        s(2, 'In the share sheet, <b>scroll down</b> the list of options (tap <b>Edit Actions… / More</b> if you don’t see it) and choose <span class="in-gly">' + PLUS + "</span> <b>Add to Home Screen</b>") +
        s(3, "Tap <b>Add</b> — Cadence lands on your home screen") +
        "</ul>" +
        '<div class="in-hint"><span class="in-gly">' + SHARE + "</span> Look for Share at the bottom of the screen</div>";
    }
    if (isIOS) { // iOS, but not Safari (Chrome/Firefox/etc. can’t install on iOS)
      return '<div class="in-note">On iPhone &amp; iPad, only <b>Safari</b> can add apps to the home screen.<br>Open <b>cadence in Safari</b>, then tap ' +
        '<span class="in-gly">' + SHARE + "</span> <b>Share</b> → <b>Add to Home Screen</b>.</div>";
    }
    if (isAndroid) {
      return '<ul class="in-steps">' +
        s(1, "Tap the browser <b>menu</b> (⋮)") +
        s(2, "Tap <b>Install app</b> or <b>Add to Home screen</b>") +
        s(3, "Confirm — Cadence appears as an app") +
        "</ul>";
    }
    return '<div class="in-note">In Chrome or Edge, click the <b>install</b> icon at the right of the address bar, or open the browser menu and choose <b>Install Cadence</b>.</div>';
  }

  var overlay = null;
  function onKey(e) { if (e.key === "Escape") close(false); }
  function close(snooze) {
    if (snooze) lset("cad-install-snooze", String(Date.now() + 10 * 864e5)); // 10 days
    if (overlay) { overlay.remove(); overlay = null; }
    document.removeEventListener("keydown", onKey, true);
  }

  function open() {
    if (standalone()) return; // already installed
    injectStyles();
    if (overlay) close(false);
    var native = nativePrompt();
    var body = native
      ? '<button class="in-install" id="in-go">Install Cadence</button>' +
        '<div class="in-note">Adds Cadence to your device — full screen, works offline, and can send you score alerts.</div>'
      : stepsHtml();
    overlay = document.createElement("div");
    overlay.className = "in-ov";
    overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-label", "Add Cadence to your home screen");
    overlay.innerHTML =
      '<div class="in-back"></div>' +
      '<div class="in-sheet"><div class="in-grab"></div>' +
      '<button class="in-x" type="button" aria-label="Close">×</button>' +
      '<div class="in-head"><img class="in-icon" src="' + ICON + '" alt="" width="52" height="52">' +
      '<div class="in-htext"><div class="in-title">Add Cadence to your Home Screen</div>' +
      '<div class="in-sub">Open it like a real app — full screen, offline-ready, and score alerts.</div></div></div>' +
      body +
      '<div class="in-actions"><button class="in-later" type="button">Maybe later</button></div>' +
      '<button class="in-never" type="button">Don’t show this again</button>' +
      "</div>";
    document.body.appendChild(overlay);
    overlay.querySelector(".in-back").addEventListener("click", function () { close(true); });
    overlay.querySelector(".in-x").addEventListener("click", function () { close(true); });
    overlay.querySelector(".in-later").addEventListener("click", function () { close(true); });
    overlay.querySelector(".in-never").addEventListener("click", function () { lset("cad-install-snooze", String(Date.now() + 3650 * 864e5)); close(false); });
    var go = overlay.querySelector("#in-go");
    if (go) go.addEventListener("click", function () {
      var ev = nativePrompt();
      if (!ev) return;
      window.__cadInstallEvent = null;
      ev.prompt();
      ev.userChoice && ev.userChoice.then(function () { close(false); });
    });
    document.addEventListener("keydown", onKey, true);
  }

  // occasional nudge for people who haven't installed
  function maybeNudge() {
    if (standalone()) return;                              // installed → never
    try { if (sessionStorage.getItem("cad-install-session")) return; } catch (e) {}
    var visits = +(lget("cad-install-visits") || 0);
    if (visits < 2) return;                                // don't nag first-timers
    if (Date.now() < +(lget("cad-install-snooze") || 0)) return; // snoozed
    if (document.querySelector(".rc-overlay,.sr-overlay,.ar-overlay,.cad-ov,.in-ov,.ob-ov")) return; // don't stack
    try { sessionStorage.setItem("cad-install-session", "1"); } catch (e) {}
    open();
  }

  // capture the Android/desktop native prompt as early as possible
  addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); window.__cadInstallEvent = e; });
  addEventListener("appinstalled", function () { window.__cadInstallEvent = null; close(false); });

  // count this visit, then consider a nudge a few seconds in (after the app
  // settles and any recap/championship popup has had first dibs)
  lset("cad-install-visits", String(+(lget("cad-install-visits") || 0) + 1));
  if (!standalone()) setTimeout(function () { try { maybeNudge(); } catch (e) {} }, 7000);

  window.CadInstall = {
    open: open, standalone: standalone,
    canInstall: function () { return !standalone(); },
    isIOS: function () { return isIOS; },
  };
})();
