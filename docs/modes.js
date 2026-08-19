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
    // the registry is the authority on which apps exist; the inline fallback
    // keeps a registry-less page working and mirrors registry.js exactly
    if (window.CAD_REGISTRY) return CAD_REGISTRY.byPath(path).id;
    if (path.indexOf("/wgi/guard") >= 0) return "wgi-guard";
    if (path.indexOf("/wgi/percussion") >= 0) return "wgi-perc";
    if (path.indexOf("/wgi/winds") >= 0) return "wgi-winds";
    return "dci";
  }
  var cur = here();

  /* No emoji: circuits get lettermark badges, activities get stroke icons —
     the same visual language as the rest of the app chrome. */
  function mark(txt, grad) {
    return '<span class="cm-mark" style="background:' + grad + '">' + txt + "</span>";
  }
  function sic(d) {
    return '<span class="cm-sic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="' + d + '"/></svg></span>';
  }
  var IC = {
    guard: "M6 21V3.5M6 4h11l-2.5 3.5L17 11H6",                       // flag
    perc:  "M4 9c0-1.7 3.6-3 8-3s8 1.3 8 3M4 9v7c0 1.7 3.6 3 8 3s8-1.3 8-3V9M4 9c0 1.7 3.6 3 8 3s8-1.3 8-3M7.5 4l3 5.5M16.5 4l-3 5.5", // drum
    winds: "M7 4v11.5M7 4l4 1v3L7 7M7 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM13 8c2 1 5 4 4 8-.6 2.4-2.8 4-5 4", // horn-ish
    space: "M4 6h7v12H4zM13 6h7v7h-7zM13 17h7",                       // workspace panes
    plus:  "M12 4v16M4 12h16",                                        // plus
    star:  "M12 4l2.3 4.9 5.2.7-3.8 3.7.9 5.2-4.6-2.5-4.6 2.5.9-5.2L4.5 9.6l5.2-.7z",
  };
  var WGI_KIDS = [
    { id: "wgi-guard", icon: sic(IC.guard), name: "Color Guard", href: base + "/wgi/guard/" },
    { id: "wgi-perc", icon: sic(IC.perc), name: "Percussion", href: base + "/wgi/percussion/" },
    { id: "wgi-winds", icon: sic(IC.winds), name: "Winds", href: base + "/wgi/winds/" },
  ];
  var wgiCur = null;
  for (var wk = 0; wk < WGI_KIDS.length; wk++) if (WGI_KIDS[wk].id === cur) wgiCur = WGI_KIDS[wk];
  var ITEMS = [
    { head: "Drum corps" },
    { id: "dci", icon: mark("DCI", "linear-gradient(135deg,#0a3f6b,#1971c2)"),
      name: "DCI", sub: "Live scores & history back to 1972", href: base + "/", indent: true },
    { head: "WGI · Sport of the Arts" },
    { group: "wgi", icon: mark("WGI", "linear-gradient(135deg,#5f3dc4,#845ef7)"), name: "WGI", indent: true,
      sub: wgiCur ? "Sport of the Arts — " + wgiCur.name : "Sport of the Arts — pick an activity",
      kids: WGI_KIDS },
  ];

  var css = [
    "#cadModeMenu{position:fixed;z-index:1000;top:54px;left:10px;min-width:300px;max-height:min(78vh,560px);overflow:auto;",
    "background:var(--surface-1,#fff);color:var(--text-primary,#16233d);",
    "border:1px solid var(--border,#dfe4ec);border-radius:16px;",
    "box-shadow:0 4px 12px rgba(10,25,50,.10),0 18px 44px rgba(10,25,50,.22);padding:8px;display:none}",
    "#cadModeMenu.open{display:block}",
    "#cadModeMenu .cm-h{font-size:11px;font-weight:800;letter-spacing:.7px;",
    "text-transform:uppercase;color:var(--muted,#74808f);padding:9px 12px 3px}",
    "#cadModeMenu a{display:flex;align-items:center;gap:11px;",
    "padding:9px 12px;border-radius:11px;color:inherit;text-decoration:none}",
    "#cadModeMenu a.cm-ind{padding-left:22px}",
    "#cadModeMenu a:hover{background:var(--surface-2,#eef1f6)}",
    "#cadModeMenu .cm-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;",
    "width:30px;height:30px;border-radius:9px;color:#fff;font-size:9.5px;font-weight:800;letter-spacing:.4px}",
    "#cadModeMenu .cm-sic{display:inline-flex;align-items:center;justify-content:center;flex:none;",
    "width:30px;height:30px;border-radius:9px;background:var(--surface-2,#eef1f6);color:var(--link,#1c5fa8)}",
    "#cadModeMenu .cm-sic svg{width:17px;height:17px}",
    "#cadModeMenu b{display:block;font-size:14px}",
    "#cadModeMenu .cm-sub{font-size:11px;color:var(--muted,#74808f)}",
    "#cadModeMenu .cm-on{background:var(--accent-wash,rgba(240,180,41,.16))}",
    "#cadModeMenu .cm-on b:after{content:' ✓';color:var(--accent,#d97706)}",
    "#cadModeMenu .cm-all{border-top:1px solid var(--grid,#e4e9f1);margin-top:6px;padding-top:10px}",
    "#cadModeMenu .cm-all+.cm-all{border-top:0;margin-top:0;padding-top:9px}",
    "#cadModeMenu .cm-all b{font-size:13.5px;color:var(--link,#1c5fa8)}",
    "#cadModeMenu .cm-grp{display:flex;align-items:center;gap:11px;width:100%;text-align:left;",
    "padding:8px 12px;border:0;border-radius:10px;background:none;color:inherit;font:inherit;cursor:pointer}",
    "#cadModeMenu .cm-grp:hover{background:var(--surface-2,#eef1f6)}",
    "#cadModeMenu .cm-grp.cm-ind{padding-left:22px}",
    "#cadModeMenu .cm-caret2{margin-left:auto;font-size:11px;color:var(--muted,#74808f);transition:transform .15s}",
    "#cadModeMenu .cm-grp[aria-expanded=true] .cm-caret2{transform:rotate(90deg)}",
    "#cadModeMenu .cm-kids{margin-left:34px;border-left:2px solid var(--grid,#e4e9f1);padding-left:4px}",
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
    ITEMS.map(function (a) {
      if (a.head) return '<div class="cm-h">' + a.head + "</div>";
      var inner = '<span class="cm-ic">' + a.icon + '</span><span><b>' + a.name + "</b>" +
        '<span class="cm-sub">' + a.sub + "</span></span>";
      if (a.kids) { // collapsible group (WGI) — one row, activities on tap
        var open = a.kids.some(function (k) { return k.id === cur; });
        return '<button type="button" class="cm-grp' + (open ? " cm-on" : "") + (a.indent ? " cm-ind" : "") +
          '" data-grp="' + a.group + '" aria-expanded="' + open + '">' + inner +
          '<span class="cm-caret2">▸</span></button>' +
          '<div class="cm-kids" data-kids="' + a.group + '"' + (open ? "" : " hidden") + ">" +
          a.kids.map(function (k) {
            return '<a href="' + k.href + '" class="' + (k.id === cur ? "cm-on" : "") + '">' +
              '<span class="cm-ic">' + k.icon + '</span><span><b>' + k.name + "</b></span></a>";
          }).join("") + "</div>";
      }
      var cls = (a.id === cur ? "cm-on" : "") + (a.indent ? " cm-ind" : "");
      return '<a href="' + a.href + '" class="' + cls + '">' + inner + "</a>";
    }).join("") +
    '<a class="cm-all" href="' + base + '/ensemble/">' + sic(IC.space) + "<span><b>My Workspaces</b>" +
      '<span class="cm-sub">Your organization’s private side of Cadence</span></span></a>' +
    '<a class="cm-all" href="' + base + '/plus.html">' + sic(IC.plus) + "<span><b>Cadence+</b>" +
      '<span class="cm-sub">Go beyond the scores</span></span></a>' +
    '<a class="cm-all" href="' + base + '/my.html">' + sic(IC.star) + "<span><b>My Cadence</b>" +
      '<span class="cm-sub">Your favorites in one place</span></span></a>';
  document.body.appendChild(menu);

  menu.addEventListener("click", function (e) {
    var g = e.target.closest ? e.target.closest(".cm-grp") : null;
    if (!g) return;
    var kids = menu.querySelector('[data-kids="' + g.getAttribute("data-grp") + '"]');
    if (!kids) return;
    var open = kids.hidden;
    kids.hidden = !open;
    g.setAttribute("aria-expanded", String(open));
  });

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
