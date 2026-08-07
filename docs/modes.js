/* Cadence family mode switcher — self-contained. Loaded by every Cadence app.
   Clicking the Cadence logo opens a menu to jump between the apps; everything
   else about each app is untouched. The script tag may set data-base to the
   path back to the site root (default "." for the DCI app at the root). */
(function () {
  "use strict";
  var script = document.currentScript;
  var base = (script && script.getAttribute("data-base")) || ".";
  var path = location.pathname;
  function here() {
    if (path.indexOf("/wgi/guard") >= 0) return "wgi-guard";
    if (path.indexOf("/wgi/percussion") >= 0) return "wgi-perc";
    if (path.indexOf("/wgi/winds") >= 0) return "wgi-winds";
    if (path.indexOf("/boa") >= 0) return "boa";
    if (path.indexOf("/usbands") >= 0) return "usb";
    return "dci";
  }
  var cur = here();

  var ITEMS = [
    { id: "dci", icon: "🥁", name: "DCI", sub: "Drum corps — live scores & history", href: base + "/" },
    { head: "WGI · Sport of the Arts" },
    { id: "wgi-guard", icon: "🚩", name: "WGI Color Guard", sub: "Demo season", href: base + "/wgi/guard/", indent: true },
    { id: "wgi-perc", icon: "🥁", name: "WGI Percussion", sub: "Demo season", href: base + "/wgi/percussion/", indent: true },
    { id: "wgi-winds", icon: "🎷", name: "WGI Winds", sub: "Demo season", href: base + "/wgi/winds/", indent: true },
    { head: "More circuits" },
    { id: "boa", icon: "🎺", name: "Bands of America", sub: "Demo season", href: base + "/boa/" },
    { id: "usb", icon: "🎼", name: "US Bands", sub: "Demo season", href: base + "/usbands/" },
  ];

  var css = [
    "#cadModeMenu{position:fixed;z-index:1000;top:54px;left:10px;min-width:288px;max-height:min(78vh,560px);overflow:auto;",
    "background:var(--surface-1,#fff);color:var(--text-primary,#16233d);",
    "border:1px solid var(--baseline,#c4cdda);border-radius:14px;",
    "box-shadow:0 12px 34px rgba(10,25,50,.25);padding:6px;display:none}",
    "#cadModeMenu.open{display:block}",
    "#cadModeMenu .cm-h{font-size:11px;font-weight:800;letter-spacing:.7px;",
    "text-transform:uppercase;color:var(--muted,#74808f);padding:9px 12px 3px}",
    "#cadModeMenu a{display:flex;align-items:center;gap:11px;",
    "padding:8px 12px;border-radius:10px;color:inherit;text-decoration:none}",
    "#cadModeMenu a.cm-ind{padding-left:22px}",
    "#cadModeMenu a:hover{background:var(--surface-2,#eef1f6)}",
    "#cadModeMenu .cm-ic{font-size:19px;width:24px;text-align:center}",
    "#cadModeMenu b{display:block;font-size:14px}",
    "#cadModeMenu .cm-sub{font-size:11px;color:var(--muted,#74808f)}",
    "#cadModeMenu .cm-on{background:var(--accent-wash,rgba(240,180,41,.16))}",
    "#cadModeMenu .cm-on b:after{content:' ✓';color:var(--accent,#d97706)}",
    "#cadModeMenu .cm-all{border-top:1px solid var(--grid,#e4e9f1);margin-top:5px;",
    "padding-top:9px;font-size:13px;font-weight:650;color:var(--link,#1c5fa8)}",
    ".brand{position:relative}",
    ".brand .cm-caret{font-size:9px;opacity:.75;margin-left:4px}",
  ].join("");

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var menu = document.createElement("div");
  menu.id = "cadModeMenu";
  menu.setAttribute("role", "menu");
  menu.innerHTML =
    '<div class="cm-h">Cadence apps</div>' +
    ITEMS.map(function (a) {
      if (a.head) return '<div class="cm-h">' + a.head + "</div>";
      var inner = '<span class="cm-ic">' + a.icon + '</span><span><b>' + a.name + "</b>" +
        '<span class="cm-sub">' + a.sub + "</span></span>";
      var cls = (a.id === cur ? "cm-on" : "") + (a.indent ? " cm-ind" : "");
      return '<a href="' + a.href + '" class="' + cls + '">' + inner + "</a>";
    }).join("") +
    '<a class="cm-all" href="' + base + '/plus.html">✨ Cadence+ — go beyond the scores →</a>' +
    '<a class="cm-all" href="' + base + '/modes.html">About the Cadence family →</a>';
  document.body.appendChild(menu);

  var brand = document.querySelector(".brand");
  if (!brand) return;
  var caret = document.createElement("span");
  caret.className = "cm-caret";
  caret.textContent = "▼";
  brand.appendChild(caret);

  function close() { menu.classList.remove("open"); }
  brand.addEventListener("click", function (e) {
    e.preventDefault(); // the logo opens the app switcher instead of routing home
    var r = brand.getBoundingClientRect();
    menu.style.top = r.bottom + 6 + "px";
    menu.style.left = Math.max(8, r.left) + "px";
    menu.classList.toggle("open");
  });
  document.addEventListener("click", function (e) {
    if (!menu.contains(e.target) && !brand.contains(e.target)) close();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
})();
