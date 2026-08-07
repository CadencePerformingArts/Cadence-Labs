/* Cadence family mode switcher — self-contained. Loaded by every Cadence app
   (DCI, WGI, …). Clicking the Cadence logo opens a menu to jump between the
   apps; everything else about each app is untouched.
   The script tag may set data-base to the path back to the site root
   (default "." for the DCI app at the root, ".." for apps in subfolders). */
(function () {
  "use strict";
  var script = document.currentScript;
  var base = (script && script.getAttribute("data-base")) || ".";
  var here = location.pathname.indexOf("/wgi/") >= 0 ? "wgi" : "dci";

  var APPS = [
    { id: "dci", icon: "🥁", name: "DCI", sub: "Drum corps — live scores & history", href: base + "/" },
    { id: "wgi", icon: "🚩", name: "WGI", sub: "Guard · Percussion · Winds — demo", href: base + "/wgi/" },
    { id: "boa", icon: "🎺", name: "Bands of America", sub: "Coming soon" },
    { id: "aca", icon: "🎤", name: "A Cappella", sub: "Coming soon" },
    { id: "sc", icon: "🎭", name: "Show Choir", sub: "Coming soon" },
  ];

  var css = [
    "#cadModeMenu{position:fixed;z-index:1000;top:54px;left:10px;min-width:270px;",
    "background:var(--surface-1,#fff);color:var(--text-primary,#16233d);",
    "border:1px solid var(--baseline,#c4cdda);border-radius:14px;",
    "box-shadow:0 12px 34px rgba(10,25,50,.25);padding:6px;display:none}",
    "#cadModeMenu.open{display:block}",
    "#cadModeMenu .cm-h{font-size:11px;font-weight:800;letter-spacing:.7px;",
    "text-transform:uppercase;color:var(--muted,#74808f);padding:8px 12px 4px}",
    "#cadModeMenu a,#cadModeMenu .cm-dis{display:flex;align-items:center;gap:11px;",
    "padding:9px 12px;border-radius:10px;color:inherit;text-decoration:none}",
    "#cadModeMenu a:hover{background:var(--surface-2,#eef1f6)}",
    "#cadModeMenu .cm-ic{font-size:20px;width:24px;text-align:center}",
    "#cadModeMenu b{display:block;font-size:14.5px}",
    "#cadModeMenu .cm-sub{font-size:11.5px;color:var(--muted,#74808f)}",
    "#cadModeMenu .cm-on{background:var(--accent-wash,rgba(240,180,41,.16))}",
    "#cadModeMenu .cm-on b:after{content:' ✓';color:var(--accent,#d97706)}",
    "#cadModeMenu .cm-dis{opacity:.55;cursor:default}",
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
    APPS.map(function (a) {
      var inner = '<span class="cm-ic">' + a.icon + '</span><span><b>' + a.name + "</b>" +
        '<span class="cm-sub">' + a.sub + "</span></span>";
      if (!a.href) return '<div class="cm-dis">' + inner + "</div>";
      return '<a href="' + a.href + '" class="' + (a.id === here ? "cm-on" : "") + '">' + inner + "</a>";
    }).join("") +
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
    e.preventDefault(); // logo now opens the app switcher instead of routing home
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
