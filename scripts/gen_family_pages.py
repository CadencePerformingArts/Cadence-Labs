#!/usr/bin/env python3
"""Generate each Cadence family app instance's index.html + PWA manifest.
One template, per-mode config — adding a future app is a config entry here
plus a dataset from gen_family_data.py.

    python3 scripts/gen_family_pages.py
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

PAGES = {
    "wgi/guard": {
        "board": "history",
        "status": 'Every WGI champion on record plus the official 2027 schedule. WGI publishes live scores through its directors\' portal, so Cadence carries no season scores — we\'ve asked for access.',
        "root": "../..",
        "title": "Cadence WGI — Color Guard Scores & Standings",
        "brand_tag": "WGI",
        "activity": "Color Guard",
        "app_name": "Cadence WGI Color Guard",
        "short_name": "WGI Guard",
        "accent": "#7c3aed",
        "ns": "wgi-guard:",
        "terms": {"singular": "ensemble", "plural": "ensembles", "a": "an ensemble"},
        "events_title": "Shows",
        "nav": ["Scoreboard", "Shows", "Ensembles", "Stats"],
        "class_order": ["Independent World", "Independent Open", "Independent A", "Scholastic World", "Scholastic Open", "Scholastic A"],
        "credit": "Not affiliated with WGI Sport of the Arts.",
    },
    "wgi/percussion": {
        "board": "history",
        "status": 'Every WGI champion on record plus the official 2027 schedule. WGI publishes live scores through its directors\' portal, so Cadence carries no season scores — we\'ve asked for access.',
        "root": "../..",
        "title": "Cadence WGI — Percussion Scores & Standings",
        "brand_tag": "WGI",
        "activity": "Percussion",
        "app_name": "Cadence WGI Percussion",
        "short_name": "WGI Perc",
        "accent": "#7c3aed",
        "ns": "wgi-perc:",
        "terms": {"singular": "ensemble", "plural": "ensembles", "a": "an ensemble"},
        "events_title": "Shows",
        "nav": ["Scoreboard", "Shows", "Ensembles", "Stats"],
        "class_order": ["Independent World", "Independent Open", "Scholastic World", "Scholastic Open", "Scholastic Concert World"],
        "credit": "Not affiliated with WGI Sport of the Arts.",
    },
    "wgi/winds": {
        "board": "history",
        "status": 'Every WGI champion on record plus the official 2027 schedule. WGI publishes live scores through its directors\' portal, so Cadence carries no season scores — we\'ve asked for access.',
        "root": "../..",
        "title": "Cadence WGI — Winds Scores & Standings",
        "brand_tag": "WGI",
        "activity": "Winds",
        "app_name": "Cadence WGI Winds",
        "short_name": "WGI Winds",
        "accent": "#7c3aed",
        "ns": "wgi-winds:",
        "terms": {"singular": "ensemble", "plural": "ensembles", "a": "an ensemble"},
        "events_title": "Shows",
        "nav": ["Scoreboard", "Shows", "Ensembles", "Stats"],
        "class_order": ["Independent World", "Independent Open", "Scholastic World"],
        "credit": "Not affiliated with WGI Sport of the Arts.",
    },
    "boa": {
        "board": "event",
        "captions": True,
        "status": 'Real results from official BOA recaps — every season back to 1976, caption by caption.',
        "root": "..",
        "title": "Cadence BOA — Bands of America Scores & Results",
        "brand_tag": "BOA",
        "activity": None,
        "app_name": "Cadence BOA",
        "short_name": "Cadence BOA",
        "accent": "#dc2626",
        "ns": "boa:",
        "score_note": "Every championship has its own judging panel — this board shows each band's most recent score; compare within one event on its Shows page.",
        "terms": {"singular": "band", "plural": "bands", "a": "a band"},
        "events_title": "Shows",
        "nav": ["Scoreboard", "Shows", "Bands", "Stats"],
        "class_order": ["Class AAAA", "Class AAA", "Class AA", "Class A"],
        "credit": "Not affiliated with Music for All / Bands of America.",
    },
    "usbands": {
        "status": "Real 2024\u201325 US Bands results from every published score recap \u2014 590+ bands.",
        "root": "..",
        "title": "Cadence US Bands — Scores & National Championships",
        "brand_tag": "USB",
        "activity": None,
        "app_name": "Cadence US Bands",
        "short_name": "US Bands",
        "accent": "#be185d",
        "ns": "usb:",
        "score_note": "US Bands shows are judged per event — this board shows each band's most recent score on the road to Nationals in Allentown.",
        "terms": {"singular": "band", "plural": "bands", "a": "a band"},
        "events_title": "Shows",
        "nav": ["Scoreboard", "Shows", "Bands", "Stats"],
        "class_order": ["World", "Group V Open", "Group IV Open", "Group III Open", "Group II Open", "Group I Open", "Group II AA", "Group I AA", "Group V A", "Group IV A", "Group III A", "Group II A", "Group I A", "Group IV Regional A", "Group III Regional A", "Group II Regional A", "Group I Regional A", "Finalist"],
        "credit": "Not affiliated with US Bands.",
    },
    "uil": {
        "board": "rating",
        "results_kind": "rating",
        "status": "Real UIL Texas results — 21 rated region seasons (2005–2025, ~1,000 bands/yr) plus state placements back to 1979. Division ratings, not point scores.",
        "root": "..",
        "title": "Cadence UIL — Texas Marching Band Ratings & State Results",
        "brand_tag": "UIL",
        "activity": None,
        "app_name": "Cadence UIL Texas",
        "short_name": "UIL Texas",
        "accent": "#bf5700",
        "ns": "uil:",
        "terms": {"singular": "band", "plural": "bands", "a": "a band"},
        "events_title": "Contests",
        "nav": ["Scoreboard", "Contests", "Bands", "Stats"],
        "class_order": ["6A", "5A", "4A", "3A", "2A", "1A", "B"],
        "credit": "Not affiliated with the University Interscholastic League. Region ratings via texasmusicforms.com (CutTime LLC), state results via smbc.uiltexas.org.",
        "score_note": "UIL awards Division ratings at region contests (1 = Superior … 5 = Poor) and ordinal placements at the State Marching Band Championships — this circuit publishes no point scores, so score columns show ratings/placements instead.",
    },
    "wgasc": {
        "status": "Real 2022–2026 WGASC results — every published show, every class, with judge-level caption sheets.",
        "root": "..",
        "title": "Cadence WGASC — SoCal Winter Guard Scores & Standings",
        "brand_tag": "WGASC",
        "activity": None,
        "app_name": "Cadence WGASC",
        "short_name": "WGASC",
        "accent": "#f59e0b",
        "ns": "wgasc:",
        "terms": {"singular": "ensemble", "plural": "ensembles", "a": "an ensemble"},
        "events_title": "Shows",
        "nav": ["Scoreboard", "Shows", "Ensembles", "Stats"],
        "class_order": ["Independent World", "Independent Open", "Independent A Senior", "Independent A", "Independent Regional A", "Scholastic World", "Scholastic Open", "Scholastic AAA", "Scholastic AA", "Scholastic A", "High School AA", "High School A", "Junior High AAA", "Junior High AA", "Junior High A", "Percussion Independent World", "Percussion Independent Open", "Percussion Independent A", "Percussion Scholastic World", "Percussion Scholastic Open", "Percussion Scholastic A", "Percussion Scholastic Junior High", "Percussion Scholastic Novice", "Percussion Scholastic Regional A", "Percussion Scholastic Concert World", "Percussion Scholastic Concert Open", "Percussion Scholastic Concert A", "Percussion Scholastic Concert Junior High", "Percussion Scholastic Standstill HS", "Percussion Scholastic Standstill JH", "Winds Independent World", "Winds Independent Open", "Winds Independent A", "Winds Scholastic Open", "Winds Scholastic A"],
        "credit": "Not affiliated with the Winter Guard Association of Southern California.",
        "score_note": "WGASC shows are judged per event — this board shows each ensemble's most recent score. Championship weekends double the judging panels (General Effect counts double on finals sheets), so finals scores run on a different sheet than regionals.",
        "captions": True,
    },
    "tcgc": {
        "status": "Real 2013–2026 TCGC results from official CompetitionSuite recaps — guard, percussion & winds, with judge-level captions.",
        "root": "..",
        "title": "Cadence TCGC — Texas Color Guard Circuit Scores & Standings",
        "brand_tag": "TCGC",
        "activity": None,
        "app_name": "Cadence TCGC",
        "short_name": "TCGC",
        "accent": "#b45309",
        "ns": "tcgc:",
        "terms": {"singular": "ensemble", "plural": "ensembles", "a": "an ensemble"},
        "events_title": "Shows",
        "nav": ["Scoreboard", "Shows", "Ensembles", "Stats"],
        "class_order": ["Scholastic World", "Independent World", "Scholastic Open", "Independent Open", "Scholastic National A", "Scholastic A", "Independent A", "Scholastic AA", "Scholastic JV A", "Scholastic Regional A", "Scholastic JV Regional A", "Cadet Regional A", "Cadet Novice", "Novice", "Percussion Scholastic World", "Percussion Independent World", "Percussion Scholastic Open", "Percussion Independent Open", "Percussion Scholastic A", "Percussion Independent A", "Percussion Scholastic AA", "Percussion Scholastic Concert Open", "Percussion Scholastic Concert A", "Percussion Scholastic Concert Cadet", "Winds Scholastic World", "Winds Independent World", "Winds Scholastic Open", "Winds Independent Open", "Winds Scholastic A"],
        "credit": "Not affiliated with the Texas Color Guard Circuit.",
        "score_note": "Winter shows are judged panel by panel — this board shows each ensemble's most recent score on the road to the TCGC State Championships.",
        "captions": True,
    },
    "ffcc": {
        "status": "Real FFCC results — official CompetitionSuite recaps 2022–2026 with judge captions, plus archived ffcc.org scores back to 2005.",
        "root": "..",
        "title": "Cadence FFCC — Florida Color Guard, Percussion & Winds Scores",
        "brand_tag": "FFCC",
        "activity": None,
        "app_name": "Cadence FFCC",
        "short_name": "FFCC",
        "accent": "#0e7490",
        "ns": "ffcc:",
        "terms": {"singular": "ensemble", "plural": "ensembles", "a": "an ensemble"},
        "events_title": "Shows",
        "nav": ["Scoreboard", "Shows", "Ensembles", "Stats"],
        "class_order": ["Independent World", "Independent Open", "Independent A", "Scholastic World", "Scholastic Open", "Scholastic AAA", "Scholastic AA", "Scholastic A", "Regional A", "Cadet", "Cadet Novice", "Class B", "Percussion Independent World", "Percussion Independent Open", "Percussion Independent A", "Percussion Scholastic Open", "Percussion Scholastic AA", "Percussion Scholastic A", "Percussion Scholastic Novice", "Percussion Scholastic Concert World", "Percussion Scholastic Concert Open", "Percussion Scholastic Concert A", "Winds Independent World", "Winds Independent Open", "Winds Independent A", "Winds Scholastic World", "Winds Scholastic Open", "Winds Scholastic A"],
        "credit": "Not affiliated with the Florida Federation of Colorguards Circuit.",
        "score_note": "One circuit, three activities — class names carry the activity (unprefixed classes are color guard). The board shows each ensemble's most recent score; compare within one show on its Shows page.",
        "captions": True,
    },
}

def v(rel: str) -> str:
    """Content-hash version tag for an asset under docs/, for cache busting."""
    p = DOCS / rel
    if not p.exists():
        return ""
    return "?v=" + hashlib.sha1(p.read_bytes()).hexdigest()[:8]


LOGO_SVG = """<svg viewBox="0 0 64 64" width="30" height="30" aria-hidden="true">
      <rect x="3" y="3" width="58" height="58" rx="15" fill="#339af0"/>
      <g stroke="#ffd43b" stroke-width="6.5" stroke-linecap="round">
        <line x1="16" y1="26" x2="16" y2="38"/>
        <line x1="27" y1="20" x2="27" y2="44"/>
        <line x1="38" y1="28" x2="38" y2="36"/>
        <line x1="49" y1="16" x2="49" y2="48"/>
      </g>
    </svg>"""

# Matches the DCI index.html theme controller so Settings works identically
# and light/dark follows the same shared preference on every Cadence app.
CAD_THEME = """window.CadTheme = (function () {
  var root = document.documentElement;
  function effective() {
    return root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  function mode() { return localStorage.getItem("cad-theme") || "auto"; }
  function paintMeta() {
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = effective() === "dark" ? "#0a2537" : "#0a3f6b";
  }
  function set(next) {
    if (next === "auto") { delete root.dataset.theme; localStorage.removeItem("cad-theme"); }
    else { root.dataset.theme = next; localStorage.setItem("cad-theme", next); }
    paintMeta();
  }
  var mq = matchMedia("(prefers-color-scheme: dark)");
  if (mq.addEventListener) mq.addEventListener("change", paintMeta);
  paintMeta();
  return { effective: effective, mode: mode, set: set, paintMeta: paintMeta };
})();"""


def page(key: str, c: dict) -> str:
    r = c["root"]
    cfg = {
        "appName": c["app_name"],
        "root": r,
        # apps with real caption datasets get the full DCI Captions tab;
        # everyone else lands on Compare
        "captions": c.get("captions", False),
        "resultsKind": c.get("results_kind"),
        "board": c.get("board", "trend"),
        "ns": c["ns"],
        "classOrder": c["class_order"],
        "combinable": [],
        "terms": c["terms"],
        "eventsTitle": c["events_title"],
        "scoreNote": c.get("score_note"),
        "siteUrl": f"https://cadenceperformingarts.github.io/Cadence-Labs/{key}",
        "siteLabel": "cadenceperformingarts.github.io/Cadence-Labs",
    }
    activity_chip = (
        f'<span class="fam-activity">{c["activity"]}</span>' if c["activity"] else ""
    )
    v_app_css, v_fam_css = v("app.css"), v("family/family.css")
    v_charts, v_wrapped = v("charts.js"), v("family/wrapped.js")
    v_engine, v_modes = v("family/app.js"), v("modes.js")
    v_sbvend, v_sbcfg, v_acct = v("vendor/supabase.min.js"), v("supabase.js"), v("account.js")
    v_metrics = v("analytics.js")
    v_ens = v("ensembles.js")
    v_board = v("family/board.js")
    v_mode = v("mode.js")
    nav = c["nav"]
    et = c.get("extra_tab")
    extra_tab_html = (
        f'<a href="{et[1]}" data-route="champions" data-href="{et[1]}">'
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        '<path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/></svg>'
        f'<span>{et[0]}</span></a>' if et else "")
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{c["title"]}</title>
<meta name="description" content="{c["app_name"]} — part of the Cadence scoreboard family. {c.get("status", "")}">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#0a3f6b">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="{r}/icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="{c["short_name"]}">
<link rel="icon" href="{r}/icons/icon-192.png">
<script>(function(){{var r=document.documentElement;var t=localStorage.getItem("cad-theme");if(t)r.dataset.theme=t;
var fs=localStorage.getItem("cad-fontsize");if(fs&&fs!=="1")r.style.zoom=fs;
var name=localStorage.getItem("cad-corps-theme"),css=localStorage.getItem("cad-corps-css");
if(name&&css){{var s=document.createElement("style");s.id="corpsTheme";s.textContent=css;document.head.appendChild(s);
r.setAttribute("data-corps",name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""));}}}})();</script>
<link rel="stylesheet" href="{r}/app.css{v_app_css}">
<link rel="stylesheet" href="{r}/family/family.css{v_fam_css}">
<style>:root {{ --fam-accent: {c["accent"]}; }}</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="#/">
    {LOGO_SVG}
    <span>Cadence <b>{c["brand_tag"]}</b></span>{activity_chip}
  </a>
  <nav id="nav">
    <a href="#/" data-route="rankings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 20V12"/><path d="M12 20V5"/><path d="M19 20v-6"/><path d="M3 20h18"/></svg><span>{nav[0]}</span></a>
    <a href="#/events" data-route="events"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg><span>{nav[1]}</span></a>
    <a href="#/corps" data-route="corps"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 5l10 4M17 5L7 9"/><rect x="4" y="9" width="16" height="9" rx="2"/><path d="M4 12.5h16"/></svg><span>{nav[2]}</span></a>
    <a href="#/data" data-route="data"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6"/><path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3"/></svg><span>{nav[3]}</span></a>
  {extra_tab_html}
    <a href="{r}/ensemble/" class="navmy" title="Your workspaces — the private side of Cadence"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h7v12H4zM13 6h7v7h-7z"/><path d="M13 17h7"/></svg><span>Workspace</span></a>
  </nav>
  <a id="settingsBtn" href="#/settings" title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M11.078 2.25c-.917 0-1.699.663-1.85 1.567L9.05 4.889c-.02.12-.115.26-.297.348a7.493 7.493 0 0 0-.986.57c-.166.115-.334.126-.45.083L6.3 6.087a1.875 1.875 0 0 0-2.282.819l-.922 1.597a1.875 1.875 0 0 0 .432 2.385l.84.692c.095.078.17.229.154.43a7.598 7.598 0 0 0 0 1.139c.015.2-.059.352-.153.43l-.841.692a1.875 1.875 0 0 0-.432 2.385l.922 1.597a1.875 1.875 0 0 0 2.282.818l1.019-.382c.115-.043.283-.031.45.082.312.214.641.405.985.57.182.088.277.228.297.35l.178 1.071c.151.904.933 1.567 1.85 1.567h1.844c.916 0 1.699-.663 1.85-1.567l.178-1.072c.02-.12.114-.26.297-.349.344-.165.673-.356.985-.57.167-.114.335-.125.45-.082l1.02.382a1.875 1.875 0 0 0 2.28-.819l.923-1.597a1.875 1.875 0 0 0-.432-2.385l-.84-.692c-.095-.078-.17-.229-.154-.43a7.614 7.614 0 0 0 0-1.139c-.016-.2.059-.352.153-.43l.84-.692c.708-.582.891-1.59.433-2.385l-.922-1.597a1.875 1.875 0 0 0-2.282-.818l-1.019.382c-.115.043-.283.031-.45-.083a7.49 7.49 0 0 0-.985-.57c-.183-.087-.277-.227-.297-.348l-.179-1.072a1.875 1.875 0 0 0-1.85-1.567h-1.843ZM12 15.75a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Z"/></svg></a>
  <div class="updated" id="updated" title="Data status"></div>
</header>

<main id="app" class="viz-root">
  <div class="loading">Loading…</div>
</main>

<footer class="foot">
  <div><a href="#" id="installBtn" hidden><b>📲 Get the App</b> — install {c["app_name"]} on this device</a></div>
  <div>Part of <b>Cadence</b> — tap the Cadence logo to switch apps</div>
  <div>{c.get("status", "")} {c["credit"]}</div>
  <div class="credit">Created by Lucas Besel</div>
</footer>

<div id="tooltip" class="tooltip" hidden></div>
<script>
window.APP_CFG = {json.dumps(cfg)};
{CAD_THEME}
(function () {{
  addEventListener("beforeinstallprompt", function (e) {{ e.preventDefault(); window.__famInstallEvent = e; }});
  var btn = document.getElementById("installBtn");
  if (!btn) return;
  var standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  btn.hidden = !!standalone;
  btn.addEventListener("click", function (e) {{
    e.preventDefault();
    if (window.__famInstallEvent) {{ window.__famInstallEvent.prompt(); return; }}
    alert(/iPhone|iPad|iPod/.test(navigator.userAgent)
      ? "Install {c["app_name"]}:\\n\\n1. Tap the Share button\\n2. Choose “Add to Home Screen”"
      : "In your browser menu, choose “Install app” / “Add to Home screen”.");
  }});
  addEventListener("appinstalled", function () {{ btn.hidden = true; }});
}})();
</script>
<script src="{r}/vendor/supabase.min.js{v_sbvend}"></script>
<script src="{r}/supabase.js{v_sbcfg}"></script>
<script src="{r}/account.js{v_acct}"></script>
<script src="{r}/analytics.js{v_metrics}"></script>
<script src="{r}/ensembles.js{v_ens}"></script>
<script src="{r}/charts.js{v_charts}"></script>
<script src="{r}/family/wrapped.js{v_wrapped}"></script>
<script src="{r}/family/board.js{v_board}"></script>
<script src="{r}/family/app.js{v_engine}"></script>
<script src="{r}/mode.js{v_mode}" data-base="{r}"></script>
<script src="{r}/modes.js{v_modes}" data-base="{r}"></script>
</body>
</html>
"""


def manifest(key: str, c: dict) -> dict:
    depth = key.count("/") + 1
    up = "/".join([".."] * depth)
    return {
        "name": c["app_name"],
        "short_name": c["short_name"],
        "description": f"{c['app_name']} — part of the Cadence scoreboard family.",
        "start_url": "./",
        "scope": "./",
        "display": "standalone",
        "background_color": "#f2f4f8",
        "theme_color": "#0a3f6b",
        "icons": [
            {"src": f"{up}/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": f"{up}/icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": f"{up}/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }


def main() -> None:
    for key, c in PAGES.items():
        d = DOCS / key
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(page(key, c))
        (d / "manifest.webmanifest").write_text(json.dumps(manifest(key, c), indent=1))
        print(f"wrote {key}/index.html + manifest")


if __name__ == "__main__":
    main()
