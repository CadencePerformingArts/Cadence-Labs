/* Cadence — DCI World Championships "Championship Mode" (temporary: Aug 6–8, 2026).
   A self-contained surprise overlay that sits ON TOP of the normal app. It never
   alters the app underneath and cleans itself up completely. To remove after the
   trip: delete this file, its <script> tag in index.html, and its SW cache entry.

   Everything is namespaced (.cm-* / cad-cm-* localStorage / window.CadChamp) and
   reuses the app's CSS variables so it matches light/dark automatically. */
(function () {
  "use strict";

  // ---- configuration ---------------------------------------------------------
  var TZ = "America/New_York";              // Indianapolis / Lucas Oil Stadium is Eastern
  var FINALS_TARGET = "2026-08-08T17:00:00-04:00"; // Finals countdown target (ET, EDT = -04:00)
  var DATE = { prelims: "2026-08-06", semis: "2026-08-07", finals: "2026-08-08" };
  // short-lived preview of the end-of-season tribute LAYOUT (nameless, sample
  // numbers) so it can be eyeballed now. It auto-pops until this instant, then
  // vanishes. Set to "" to turn off. Deliberately generic so it reveals nothing.
  var PREVIEW_MOCK_UNTIL = "";

  var VENUE = "Lucas Oil Stadium";
  var DENY_LINES = [
    "Too bad. Championship Mode is mandatory.",
    "Request denied. Your denial has been denied.",
    "Nice try. Championship Mode is happening anyway.",
    "There is no escaping DCI Worlds.",
    "Incorrect choice. Activating Championship Mode now.",
    "You really thought that button would work?"
  ];
  var MISSIONS = {
    pre: [
      "Pick the corps you’re most excited to see.",
      "Make sure your phone’s charged for the big weekend.",
      "Share Cadence with someone headed to Worlds."
    ],
    prelims: [
      "Take a picture outside Lucas Oil Stadium.",
      "Pick one corps you did not expect to love.",
      "Identify the loudest crowd reaction of the day."
    ],
    semis: [
      "Take a picture together before the first performance.",
      "Pick the corps with the best opening moment.",
      "Choose your predicted top three before scores are announced."
    ],
    finals: [
      "Take one final championship-day picture together.",
      "Choose your favorite show of the entire weekend.",
      "Stay for retreat and the championship celebration."
    ]
  };
  var NORMAL_ACT = { title: "CHAMPIONSHIP MODE ACTIVATED", sub: "Have fun, cheer loud, and enjoy DCI Worlds!" };
  var FINALS_ACT = { title: "FINALS MODE ACTIVATED", sub: "LET’S GO!" };

  // per-mode view config
  var VIEW = {
    pre:     { title: "FINALS COUNTDOWN",  note: "DCI Worlds is almost here — get ready!", countdown: true,  missions: "pre",     act: NORMAL_ACT, conf: { count: 150, duration: 3800, big: false } },
    prelims: { title: "PRELIMS DAY",       note: "",                            countdown: true,  missions: "prelims", act: NORMAL_ACT, conf: { count: 160, duration: 3800, big: false } },
    semis:   { title: "SEMIFINALS DAY",    note: "",                            countdown: true,  missions: "semis",   act: NORMAL_ACT, conf: { count: 160, duration: 3800, big: false } },
    finals:  { title: "IT’S FINALS DAY!", note: "One final night. Cheer loud, enjoy every moment, and watch a champion be crowned.", countdown: false, missions: "finals", act: FINALS_ACT, conf: { count: 280, duration: 5000, big: true } }
  };

  // ---- Colin tribute config (after-finals surprise) --------------------------
  var COLIN = { name: "Colin Besel", corps: "Phantom Regiment", year: "2026", home: "Rockford, IL" };
  var COLIN_AFTER = "2026-08-09T00:00:00-04:00"; // the day after Finals — Aug 9 (ET) only
  var COLIN_END = "2026-08-10T00:00:00-04:00";   // retires at end of Aug 9 — then nothing shows, ever
  // coordinates for a mileage estimate — Phantom's 2026 tour cities + home + Indy,
  // with US state centroids as a fallback for anything unexpected.
  var CITY = {
    "Rockford, IL": [42.271, -89.094], "Fort Collins, CO": [40.585, -105.084], "Omaha, NE": [41.257, -95.995],
    "La Crosse, WI": [43.801, -91.239], "Lisle, IL": [41.801, -88.075], "Whitewater, WI": [42.833, -88.732],
    "Olathe, KS": [38.881, -94.819], "Broken Arrow, OK": [36.036, -95.797], "Denton, TX": [33.215, -97.133],
    "San Antonio, TX": [29.424, -98.494], "McKinney, TX": [33.197, -96.615], "Evansville, IN": [37.971, -87.571],
    "Madison, WI": [43.073, -89.401], "DeKalb, IL": [41.929, -88.750], "Lawrence, MA": [42.707, -71.163],
    "Allentown, PA": [40.608, -75.490], "Lexington, KY": [38.041, -84.504], "Indianapolis, IN": [39.769, -86.158]
  };
  var STATE = {
    AL: [32.8, -86.8], AK: [64.1, -152.3], AZ: [34.2, -111.7], AR: [34.9, -92.4], CA: [37.2, -119.3],
    CO: [39.0, -105.5], CT: [41.6, -72.7], DE: [39.0, -75.5], FL: [28.6, -82.4], GA: [32.6, -83.4],
    HI: [20.3, -156.4], ID: [44.4, -114.6], IL: [40.0, -89.2], IN: [39.9, -86.3], IA: [42.0, -93.5],
    KS: [38.5, -98.4], KY: [37.5, -85.3], LA: [31.0, -92.0], ME: [45.4, -69.2], MD: [39.0, -76.8],
    MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3], MS: [32.7, -89.7], MO: [38.4, -92.5],
    MT: [46.9, -110.0], NE: [41.5, -99.8], NV: [39.3, -116.6], NH: [43.7, -71.6], NJ: [40.2, -74.7],
    NM: [34.4, -106.1], NY: [42.9, -75.6], NC: [35.6, -79.4], ND: [47.5, -100.5], OH: [40.3, -82.8],
    OK: [35.6, -97.5], OR: [44.0, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.5], SC: [33.9, -80.9],
    SD: [44.4, -100.2], TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7], VT: [44.1, -72.7],
    VA: [37.5, -78.9], WA: [47.4, -120.5], WV: [38.6, -80.6], WI: [44.6, -89.9], WY: [43.0, -107.6]
  };
  function coord(loc) {
    if (!loc) return null;
    if (CITY[loc]) return CITY[loc];
    var st = String(loc).split(",").pop().trim().toUpperCase();
    return STATE[st] || null;
  }
  function haversine(a, b) {
    var R = 3958.8, toR = Math.PI / 180;
    var la1 = a[0] * toR, la2 = b[0] * toR, dLa = (b[0] - a[0]) * toR, dLo = (b[1] - a[1]) * toR;
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function milesFor(locs) {
    var pts = locs.map(coord).filter(Boolean), sum = 0;
    for (var i = 1; i < pts.length; i++) sum += haversine(pts[i - 1], pts[i]);
    return Math.round(sum * 1.25 / 50) * 50; // road factor, rounded to a clean 50
  }
  function ordinal(n) {
    if (n == null) return "—";
    var s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ---- date / mode helpers ---------------------------------------------------
  function etDate(d) { // reliable ET calendar date regardless of device timezone
    return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d || new Date());
  }
  function todayET() { return etDate(new Date()); }
  function modeForDate(ds) {
    if (ds === DATE.prelims) return "prelims";
    if (ds === DATE.semis) return "semis";
    if (ds === DATE.finals) return "finals";
    if (ds < DATE.prelims) return "pre";
    return "off"; // after finals — feature dormant
  }
  function dateForMode(mode) {
    return DATE[mode] || todayET(); // "pre" has no missions; today is fine
  }
  function isEventDay(mode) { return mode === "prelims" || mode === "semis" || mode === "finals"; }

  // ---- localStorage ----------------------------------------------------------
  function lget(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function missionsState(date) {
    try { var a = JSON.parse(lget("cad-cm-missions-" + date)); return Array.isArray(a) ? a : [false, false, false]; }
    catch (e) { return [false, false, false]; }
  }
  function saveMissions(date, arr) { lset("cad-cm-missions-" + date, JSON.stringify(arr)); }

  var reduceMotion = function () {
    try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  // celebratory haptic (Android; iOS doesn't expose the Vibration API so it no-ops)
  function haptic(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }

  // ---- styles (injected once) ------------------------------------------------
  function injectStyles() {
    if (document.getElementById("cm-style")) return;
    var css = [
      ".cm-overlay{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;}",
      ".cm-overlay[hidden]{display:none;}",
      ".cm-backdrop{position:absolute;inset:0;background:rgba(8,20,38,.62);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);}",
      ".cm-card{position:relative;z-index:3;width:100%;max-width:440px;max-height:92vh;overflow-y:auto;background:var(--surface-1);color:var(--text-primary);border:1px solid var(--border);border-radius:20px;box-shadow:0 24px 70px rgba(8,20,38,.5);animation:cm-pop .34s cubic-bezier(.2,.9,.3,1.2) both;-webkit-overflow-scrolling:touch;}",
      "@keyframes cm-pop{from{opacity:0;transform:translateY(14px) scale(.96);}to{opacity:1;transform:none;}}",
      ".cm-head{position:relative;background:var(--navy);color:#fff;padding:22px 20px 18px;text-align:center;}",
      // Championship-screen header: drifting 'stadium spotlight' aurora + a fine
      // grain, layered behind the content (scoped to .cm-stage so Colin's red
      // tribute header is untouched).
      ".cm-stage{overflow:hidden;background:radial-gradient(120% 90% at 50% -10%, #12508a 0%, var(--navy) 55%);}",
      ".cm-stage>*{position:relative;z-index:1;}",
      ".cm-stage::before{content:'';position:absolute;inset:-45% -15% -20%;z-index:0;pointer-events:none;background:radial-gradient(closest-side,rgba(240,180,41,.42),transparent 70%),radial-gradient(closest-side,rgba(41,140,220,.5),transparent 72%),radial-gradient(closest-side,rgba(240,180,41,.28),transparent 70%);background-repeat:no-repeat;background-size:58% 118%,52% 120%,42% 100%;background-position:12% -8%,86% 24%,60% 90%;filter:blur(8px);opacity:.75;animation:cm-aurora 9s ease-in-out infinite alternate;}",
      "@keyframes cm-aurora{from{background-position:8% -12%,90% 16%,55% 96%;}to{background-position:30% 8%,64% 42%,68% 78%;}}",
      ".cm-x{position:absolute;top:10px;right:10px;width:34px;height:34px;border:0;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;font-size:20px;line-height:1;cursor:pointer;display:grid;place-items:center;}",
      ".cm-x:hover{background:rgba(255,255,255,.26);}",
      ".cm-eyebrow{font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:var(--gold);}",
      ".cm-title{font-size:29px;line-height:1.05;font-weight:900;letter-spacing:-.5px;margin:7px 6px 0;color:#fff;}",
      ".cm-note{font-size:13.5px;line-height:1.4;color:rgba(255,255,255,.82);margin:8px auto 0;max-width:34ch;}",
      ".cm-cd{display:flex;justify-content:center;gap:8px;margin:18px 0 6px;}",
      ".cm-cd .u{position:relative;overflow:hidden;min-width:62px;background:linear-gradient(180deg,rgba(255,255,255,.17),rgba(255,255,255,.05));border:1px solid rgba(255,255,255,.2);border-radius:14px;padding:12px 6px 9px;box-shadow:0 6px 18px rgba(0,0,0,.24),inset 0 1px 0 rgba(255,255,255,.16);}",
      ".cm-cd .u::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent,var(--gold),transparent);}",
      ".cm-cd .n{font-size:30px;font-weight:900;font-variant-numeric:tabular-nums;color:#fff;line-height:1;text-shadow:0 2px 12px rgba(0,0,0,.4);will-change:transform;}",
      ".cm-cd .l{font-size:9.5px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:var(--gold);margin-top:6px;}",
      ".cm-cd .u.pulse .n{animation:cm-tick .55s ease;}",
      "@keyframes cm-tick{0%{transform:scale(1);}42%{transform:scale(1.18);color:var(--gold);}100%{transform:scale(1);}}",
      ".cm-venue{margin-top:13px;font-size:13px;font-weight:700;color:#fff;}",
      ".cm-venue .pin{color:var(--gold);display:inline-block;animation:cm-pin 2s ease-in-out infinite;}",
      "@keyframes cm-pin{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.45;transform:scale(.78);}}",
      ".cm-body{padding:18px 20px 20px;}",
      ".cm-mtitle{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:2px 0 10px;}",
      ".cm-mtitle b{font-size:15px;font-weight:800;color:var(--text-primary);}",
      ".cm-prog{font-size:12px;font-weight:700;color:var(--muted);font-variant-numeric:tabular-nums;}",
      ".cm-prog.done{color:var(--good);}",
      ".cm-list{display:flex;flex-direction:column;gap:8px;margin-bottom:16px;}",
      ".cm-mission{display:flex;align-items:center;gap:11px;text-align:left;width:100%;font:inherit;font-size:14px;line-height:1.35;color:var(--text-primary);background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:11px 13px;cursor:pointer;}",
      ".cm-mission:hover{border-color:var(--muted);}",
      ".cm-box{flex:0 0 auto;width:22px;height:22px;border-radius:7px;border:2px solid var(--baseline);display:grid;place-items:center;color:#fff;transition:background .15s,border-color .15s;}",
      ".cm-box svg{width:14px;height:14px;opacity:0;transition:opacity .15s;}",
      ".cm-mission.done{background:var(--accent-wash);border-color:var(--gold);}",
      ".cm-mission.done .cm-box{background:var(--good);border-color:var(--good);}",
      ".cm-mission.done .cm-box svg{opacity:1;}",
      ".cm-mission.done .cm-mtext{color:var(--muted);text-decoration:line-through;}",
      ".cm-btn{display:block;width:100%;border:0;border-radius:999px;padding:15px 18px;font:inherit;font-size:17px;font-weight:800;cursor:pointer;}",
      ".cm-btn:active{transform:translateY(1px);}",
      ".cm-primary{background:var(--gold);color:#16233d;box-shadow:0 6px 18px rgba(240,180,41,.4);}",
      ".cm-primary:hover{filter:brightness(1.04);}",
      ".cm-ghost{background:transparent;color:var(--text-primary);border:2px solid var(--border);}",
      ".cm-ghost:hover{border-color:var(--muted);}",
      ".cm-row{display:flex;gap:10px;}",
      ".cm-row .cm-btn{flex:1;}",
      ".cm-ask{font-size:20px;font-weight:900;color:var(--text-primary);text-align:center;margin:6px 4px 18px;}",
      ".cm-deny{font-size:19px;font-weight:800;color:var(--text-primary);text-align:center;padding:14px 6px 4px;line-height:1.35;min-height:64px;display:flex;align-items:center;justify-content:center;}",
      // Colin tribute: Phantom-red header + stat tiles
      ".cm-head.red{background:#b3121b;}",
      ".cm-stats{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:2px 0 14px;}",
      ".cm-stat{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:12px 10px;text-align:center;}",
      ".cm-stat .v{font-size:23px;font-weight:900;color:var(--text-primary);line-height:1.05;font-variant-numeric:tabular-nums;}",
      ".cm-stat .k{margin-top:4px;font-size:11px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;color:var(--muted);}",
      ".cm-cline{font-size:14px;line-height:1.55;color:var(--text-secondary);text-align:center;margin:0 2px 16px;}",
      // full-screen activation message
      ".cm-activated{position:absolute;z-index:5;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;pointer-events:none;}",
      ".cm-act-title{font-size:34px;line-height:1.05;font-weight:900;letter-spacing:-.5px;color:#fff;text-shadow:0 3px 22px rgba(0,0,0,.6);animation:cm-rise .5s cubic-bezier(.2,.9,.3,1.2) both;}",
      ".cm-act-title.big{font-size:44px;}",
      ".cm-act-sub{margin-top:12px;font-size:18px;font-weight:700;color:#ffe08a;text-shadow:0 2px 14px rgba(0,0,0,.55);animation:cm-rise .5s .08s cubic-bezier(.2,.9,.3,1.2) both;}",
      "@keyframes cm-rise{from{opacity:0;transform:translateY(16px) scale(.94);}to{opacity:1;transform:none;}}",
      ".cm-fade{animation:cm-fadeout .55s ease forwards;}",
      "@keyframes cm-fadeout{to{opacity:0;}}",
      ".cm-confetti{position:fixed;inset:0;z-index:4;pointer-events:none;}",
      // mission-complete banner
      ".cm-mbanner{position:absolute;z-index:6;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:none;}",
      ".cm-mbwrap{text-align:center;animation:cm-pop2 .5s cubic-bezier(.2,.9,.3,1.4) both;}",
      ".cm-mbtrophy{font-size:54px;line-height:1;filter:drop-shadow(0 4px 16px rgba(0,0,0,.5));animation:cm-bounce .6s ease both;}",
      ".cm-mbanner b{display:block;margin-top:8px;font-size:26px;font-weight:900;color:#fff;text-shadow:0 3px 20px rgba(0,0,0,.65);}",
      ".cm-mbanner span{display:block;margin-top:8px;font-size:16px;font-weight:700;color:#ffe08a;text-shadow:0 2px 14px rgba(0,0,0,.6);}",
      "@keyframes cm-pop2{from{opacity:0;transform:scale(.8);}to{opacity:1;transform:none;}}",
      "@keyframes cm-bounce{0%{transform:translateY(-14px) scale(.6);opacity:0;}60%{transform:translateY(4px) scale(1.12);opacity:1;}100%{transform:none;}}",
      // top-bar reopen button (beside the settings gear, Aug 6–8 only)
      "#cm-topbtn{display:inline-flex;align-items:center;justify-content:center;background:var(--gold);color:#16233d;cursor:pointer;border:0;border-radius:10px;padding:6px;line-height:0;order:1;}",
      "#cm-topbtn:hover{filter:brightness(1.06);}",
      "#cm-topbtn svg{width:20px;height:20px;display:block;}",
      // dev preview launcher
      "#cm-dev{position:fixed;right:10px;bottom:10px;z-index:2600;font:600 12px system-ui,sans-serif;}",
      "#cm-dev summary{list-style:none;cursor:pointer;background:#16233d;color:#f0b429;border:1px solid #f0b429;border-radius:999px;padding:6px 12px;box-shadow:0 4px 14px rgba(0,0,0,.3);}",
      "#cm-dev summary::-webkit-details-marker{display:none;}",
      "#cm-dev .cm-devbox{position:absolute;right:0;bottom:38px;width:200px;background:var(--surface-1);color:var(--text-primary);border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 34px rgba(8,20,38,.4);padding:8px;display:flex;flex-direction:column;gap:6px;}",
      "#cm-dev .cm-devbox button{font:inherit;font-size:12.5px;text-align:left;padding:7px 9px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:var(--text-primary);cursor:pointer;}",
      "#cm-dev .cm-devbox button:hover{border-color:var(--muted);}",
      "#cm-dev .cm-devbox hr{border:0;border-top:1px solid var(--border);margin:2px 0;}",
      // reduced motion: kill entrance/confetti animations
      "@media (prefers-reduced-motion: reduce){.cm-card,.cm-act-title,.cm-act-sub,.cm-mbwrap,.cm-mbtrophy,.cm-mbanner b,.cm-stage::before,.cm-cd .u.pulse .n,.cm-venue .pin{animation:none !important;}.cm-fade{animation:none !important;opacity:0;}}"
    ].join("\n");
    var st = document.createElement("style");
    st.id = "cm-style";
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ---- confetti (canvas, self-cleaning, reduced-motion aware) -----------------
  function confetti(opts) {
    opts = opts || {};
    if (reduceMotion()) return { stop: function () {} }; // caller still shows the message
    haptic([16, 30, 16, 30, 90]); // a little celebratory rumble as the confetti pops
    var canvas = document.createElement("canvas");
    canvas.className = "cm-confetti";
    canvas.setAttribute("aria-hidden", "true");
    (opts.parent || document.body).appendChild(canvas);
    var ctx = canvas.getContext("2d");
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    function size() { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    size();
    window.addEventListener("resize", size);
    var COLORS = opts.colors || ["#f0b429", "#0a3f6b", "#d97706", "#2f9e44", "#1971c2", "#c2255c", "#0c8599", "#ffffff"];
    var big = opts.big, N = opts.count || 150, parts = [];
    function mk(fromTop) {
      return {
        x: Math.random() * innerWidth,
        y: fromTop ? -20 - Math.random() * innerHeight * 0.5 : Math.random() * innerHeight,
        w: (big ? 8 : 6) + Math.random() * (big ? 8 : 6),
        h: (big ? 10 : 8) + Math.random() * (big ? 10 : 8),
        vx: (Math.random() - 0.5) * (big ? 2.4 : 1.7),
        vy: (big ? 2.6 : 2) + Math.random() * (big ? 4.2 : 3.4),
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.32,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        round: Math.random() < 0.45
      };
    }
    for (var i = 0; i < N; i++) parts.push(mk(true));
    var start = null, dur = opts.duration || 4000, raf;
    function frame(t) {
      if (start == null) start = t;
      var el = t - start;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      var fade = el > dur ? Math.max(0, 1 - (el - dur) / 700) : 1;
      for (var k = 0; k < parts.length; k++) {
        var p = parts[k];
        p.x += p.vx; p.y += p.vy; p.vy += 0.035; p.rot += p.vr;
        if (el < dur && p.y > innerHeight + 24) { var n = mk(true); p.x = n.x; p.y = -20; p.vx = n.vx; p.vy = n.vy; }
        ctx.save(); ctx.globalAlpha = fade; ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color;
        if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, 6.283); ctx.fill(); }
        else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (el < dur + 700) raf = requestAnimationFrame(frame);
      else stop();
    }
    function stop() { cancelAnimationFrame(raf); window.removeEventListener("resize", size); if (canvas.parentNode) canvas.remove(); }
    raf = requestAnimationFrame(frame);
    return { stop: stop };
  }

  // ---- modal state -----------------------------------------------------------
  var overlay = null, cdTimer = null, lastFocus = null, curMode = "pre", bursts = [];

  function clearCountdown() { if (cdTimer) { clearInterval(cdTimer); cdTimer = null; } }

  function close() {
    clearCountdown();
    bursts.forEach(function (x) { try { x.stop(); } catch (e) {} });
    bursts = [];
    if (overlay) { overlay.remove(); overlay = null; }
    document.removeEventListener("keydown", onKey, true);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }

  function onKey(e) {
    if (!overlay) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") { // focus trap
      var f = overlay.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function updateCountdown() {
    if (!overlay) return;
    var wrap = overlay.querySelector(".cm-cd");
    if (!wrap) return;
    var ms = Date.parse(FINALS_TARGET) - Date.now(); if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    var vals = [[d, "Days"], [h, "Hours"], [m, "Minutes"], [s, "Seconds"]];
    // build the four tiles once, then update only the numbers that change and
    // pulse that tile — so the seconds tick every second, minutes flip on the
    // minute, etc., instead of re-rendering (and re-flashing) the whole row.
    if (wrap.children.length !== 4) {
      wrap.innerHTML = vals.map(function (v) {
        return '<div class="u"><div class="n">' + v[0] + '</div><div class="l">' + v[1] + "</div></div>";
      }).join("");
      return;
    }
    for (var i = 0; i < 4; i++) {
      var tile = wrap.children[i], nEl = tile.firstChild, nv = String(vals[i][0]);
      if (nEl.textContent !== nv) {
        nEl.textContent = nv;
        tile.classList.remove("pulse"); void tile.offsetWidth; tile.classList.add("pulse"); // restart the tick
      }
    }
  }

  // ---- render steps ----------------------------------------------------------
  function headHtml(mode) {
    var v = VIEW[mode];
    var cd = v.countdown ? '<div class="cm-cd" aria-hidden="true"></div><span class="cm-sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Counting down to DCI World Championship Finals, August 8, 2026.</span>' : "";
    var note = v.note ? '<p class="cm-note">' + esc(v.note) + "</p>" : "";
    return '<div class="cm-head cm-stage">' +
      '<button class="cm-x" type="button" aria-label="Close">×</button>' +
      '<div class="cm-eyebrow">DCI World Championships</div>' +
      '<h2 class="cm-title" id="cm-h">' + esc(v.title) + "</h2>" +
      note + cd +
      '<div class="cm-venue"><span class="pin">●</span> ' + esc(VENUE) + "</div>" +
      "</div>";
  }

  function missionsHtml(mode) {
    var key = VIEW[mode].missions;
    if (!key) return "";
    var items = MISSIONS[key], date = dateForMode(mode), st = missionsState(date);
    var done = st.filter(Boolean).length;
    var rows = items.map(function (txt, i) {
      var on = !!st[i];
      return '<button class="cm-mission' + (on ? " done" : "") + '" type="button" role="checkbox" aria-checked="' + on + '" data-i="' + i + '">' +
        '<span class="cm-box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span>' +
        '<span class="cm-mtext">' + esc(txt) + "</span></button>";
    }).join("");
    return '<div class="cm-mtitle"><b>Today’s Missions</b><span class="cm-prog' + (done === 3 ? " done" : "") + '">' + done + " of 3 completed</span></div>" +
      '<div class="cm-list">' + rows + "</div>";
  }

  function renderIntro(mode) {
    var body = overlay.querySelector(".cm-body");
    body.innerHTML = missionsHtml(mode) +
      '<button class="cm-btn cm-primary" id="cm-enter" type="button">ENTER CHAMPIONSHIP MODE</button>';
    // mission toggles
    Array.prototype.forEach.call(body.querySelectorAll(".cm-mission"), function (btn) {
      btn.addEventListener("click", function () { toggleMission(mode, +btn.dataset.i); });
    });
    body.querySelector("#cm-enter").addEventListener("click", function () { renderConfirm(mode); });
  }

  function renderConfirm(mode) {
    clearCountdown();
    var head = overlay.querySelector(".cm-head");
    if (head) { var cd = head.querySelector(".cm-cd"); if (cd) cd.remove(); }
    var body = overlay.querySelector(".cm-body");
    body.innerHTML = '<p class="cm-ask">Activate Championship Mode?</p>' +
      '<div class="cm-row"><button class="cm-btn cm-primary" id="cm-accept" type="button">ACCEPT</button>' +
      '<button class="cm-btn cm-ghost" id="cm-deny" type="button">DENY</button></div>';
    body.querySelector("#cm-accept").addEventListener("click", function () { activate(mode); });
    body.querySelector("#cm-deny").addEventListener("click", function () { renderDeny(mode); });
    body.querySelector("#cm-accept").focus();
  }

  function renderDeny(mode) {
    var body = overlay.querySelector(".cm-body");
    var line = DENY_LINES[(Math.random() * DENY_LINES.length) | 0];
    body.innerHTML = '<p class="cm-deny">' + esc(line) + "</p>";
    setTimeout(function () { if (overlay) activate(mode); }, 1050);
  }

  function activate(mode) {
    clearCountdown();
    var v = VIEW[mode], act = v.act;
    var card = overlay.querySelector(".cm-card");
    if (card) card.style.display = "none";
    var msg = document.createElement("div");
    msg.className = "cm-activated";
    msg.innerHTML = '<div class="cm-act-title' + (v.conf.big ? " big" : "") + '">' + esc(act.title) + "</div>" +
      '<div class="cm-act-sub">' + esc(act.sub) + "</div>";
    overlay.appendChild(msg);
    // move aria-labelled focus so SR announces the activation
    msg.setAttribute("role", "status");
    bursts.push(confetti({ parent: overlay, count: v.conf.count, duration: v.conf.duration, big: v.conf.big }));
    var hold = v.conf.duration;
    setTimeout(function () {
      if (!overlay) return;
      msg.classList.add("cm-fade");
      setTimeout(function () { markSeenToday(); close(); }, 560);
    }, hold);
  }

  // ---- missions --------------------------------------------------------------
  function toggleMission(mode, i) {
    var date = dateForMode(mode), st = missionsState(date);
    st[i] = !st[i];
    saveMissions(date, st);
    // repaint the mission list + progress in place
    var body = overlay.querySelector(".cm-body");
    var btns = body.querySelectorAll(".cm-mission");
    var done = st.filter(Boolean).length;
    Array.prototype.forEach.call(btns, function (b) {
      var on = !!st[+b.dataset.i];
      b.classList.toggle("done", on);
      b.setAttribute("aria-checked", on);
    });
    var prog = body.querySelector(".cm-prog");
    if (prog) { prog.textContent = done + " of 3 completed"; prog.classList.toggle("done", done === 3); }
    if (done === 3 && !lget("cad-cm-mdone-" + date)) {
      lset("cad-cm-mdone-" + date, "1");
      missionsComplete();
    }
  }

  var MISSION_LINES = [
    "All three — nailed it! 🏆",
    "Clean sweep. Enjoy the show! 🎉",
    "Mission masters. Cheer loud! 👏",
    "You did it! Now go have a blast."
  ];
  function missionsComplete() {
    if (!overlay) return;
    var line = MISSION_LINES[(Math.random() * MISSION_LINES.length) | 0];
    var banner = document.createElement("div");
    banner.className = "cm-mbanner";
    banner.setAttribute("role", "status");
    banner.innerHTML = '<div class="cm-mbwrap"><div class="cm-mbtrophy">🏆</div><b>TODAY’S MISSIONS COMPLETE!</b><span>' + esc(line) + "</span></div>";
    overlay.appendChild(banner);
    bursts.push(confetti({ parent: overlay, count: 230, duration: 2600, big: true }));
    setTimeout(function () {
      banner.classList.add("cm-fade");
      setTimeout(function () { if (banner.parentNode) banner.remove(); }, 560);
    }, 2400);
  }

  // ---- Colin tribute (after the season is over) ------------------------------
  function computeColin() {
    return fetch("data/seasons/" + COLIN.year + ".json?cb=" + Date.now(), { headers: { "cache-control": "no-cache" } })
      .then(function (r) { return r.json(); })
      .then(function (evs) {
        var rows = [];
        (evs || []).forEach(function (ev) {
          (ev.classes || []).forEach(function (cls) {
            (cls.results || []).forEach(function (r) {
              if (r.corps === COLIN.corps) rows.push({ date: ev.date, loc: ev.location, place: r.place, score: r.score });
            });
          });
        });
        rows.sort(function (a, b) { return (a.date || "").localeCompare(b.date || ""); });
        if (!rows.length) return null;
        var scores = rows.map(function (r) { return r.score; }).filter(function (s) { return s != null; });
        var places = rows.map(function (r) { return r.place; }).filter(function (p) { return p != null; });
        var cities = rows.map(function (r) { return r.loc; }).filter(Boolean);
        var first = scores[0], last = scores[scores.length - 1];
        var days = Math.round((Date.parse(rows[rows.length - 1].date) - Date.parse(rows[0].date)) / 864e5) + 1;
        return {
          shows: rows.length, days: days, miles: milesFor([COLIN.home].concat(cities)),
          gained: +(last - first).toFixed(3), first: first, last: last,
          high: Math.max.apply(null, scores), bestPlace: places.length ? Math.min.apply(null, places) : null,
          wins: rows.filter(function (r) { return r.place === 1; }).length,
          cities: new Set(cities).size,
          states: new Set(cities.map(function (c) { return c.split(",").pop().trim(); })).size
        };
      });
  }
  function realTiles(s) {
    var tiles = [
      ["Shows performed", String(s.shows)],
      ["Days on the road", String(s.days)],
      ["Miles traveled", "≈ " + s.miles.toLocaleString()],
      ["Points gained", "+" + s.gained.toFixed(1)],
      ["Highest score", s.high.toFixed(3)],
      ["Best finish", ordinal(s.bestPlace)],
      ["Cities visited", String(s.cities)],
      ["States crossed", String(s.states)]
    ];
    if (s.wins) tiles.push(["1st-place shows", String(s.wins)]);
    var line = s.days + " days · " + s.cities + " cities · ≈" + s.miles.toLocaleString() + " miles — from a " +
      s.first.toFixed(2) + " on night one to a " + s.last.toFixed(2) + " to close it out. " +
      "One unforgettable summer. We’re so proud of you, Colin. 🎺❤️";
    return { tiles: tiles, line: line };
  }
  // Representative but nameless: the SAME tile labels as the real tribute so the
  // layout previews truthfully, with sample (random) numbers and no identity.
  function mockColin() {
    var rnd = function (a, b) { return Math.floor(a + Math.random() * (b - a)); };
    return {
      tiles: [
        ["Shows performed", String(rnd(14, 22))],
        ["Days on the road", String(rnd(30, 50))],
        ["Miles traveled", "≈ " + rnd(6000, 9000).toLocaleString()],
        ["Points gained", "+" + (12 + Math.random() * 14).toFixed(1)],
        ["Highest score", (88 + Math.random() * 9).toFixed(3)],
        ["Best finish", ordinal(rnd(1, 6))],
        ["Cities visited", String(rnd(12, 20))],
        ["States crossed", String(rnd(8, 14))]
      ],
      line: "Miles of memories and a whole lot of heart — one unforgettable summer on the road. 🎺 (preview with sample numbers)"
    };
  }
  function openColin(opts) {
    opts = opts || {};
    injectStyles();
    if (overlay) close();
    lastFocus = document.activeElement;
    overlay = document.createElement("div");
    overlay.className = "cm-overlay";
    overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-labelledby", "cm-h");
    var headCls = opts.mock ? "cm-head" : "cm-head red";
    overlay.innerHTML = '<div class="cm-backdrop"></div><div class="cm-card"><div class="' + headCls + '">' +
      '<button class="cm-x" type="button" aria-label="Close">×</button>' +
      '<div class="cm-eyebrow">' + (opts.mock ? "2026 Season · Preview" : "2026 DCI World Championships") + "</div>" +
      '<h2 class="cm-title" id="cm-h">' + esc(opts.mock ? "What a Season!" : "Congratulations " + COLIN.name) + "</h2>" +
      '<p class="cm-note">' + esc(opts.mock ? "A look at the end-of-season screen — sample numbers." : COLIN.corps) + "</p>" +
      '</div><div class="cm-body"><div class="cm-cline" style="padding:14px 0">Loading…</div></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector(".cm-x").addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    var fx = overlay.querySelector(".cm-x"); if (fx) setTimeout(function () { try { fx.focus(); } catch (e) {} }, 30);

    function paint(data) {
      if (!overlay) return;
      var body = overlay.querySelector(".cm-body");
      var tiles = data.tiles.map(function (t) {
        return '<div class="cm-stat"><div class="v">' + esc(t[1]) + '</div><div class="k">' + esc(t[0]) + "</div></div>";
      }).join("");
      body.innerHTML = '<div class="cm-stats">' + tiles + "</div>" +
        (data.line ? '<p class="cm-cline">' + esc(data.line) + "</p>" : "") +
        '<button class="cm-btn cm-primary" id="cm-done" type="button">' + (opts.mock ? "Close preview" : "So proud of you ❤️") + "</button>";
      body.querySelector("#cm-done").addEventListener("click", close);
      bursts.push(confetti({ parent: overlay, count: 220, duration: 3800, big: true,
        colors: opts.mock ? null : ["#d81f26", "#ffffff", "#f0b429", "#b3121b", "#7a0d14"] }));
    }

    if (opts.mock) paint(mockColin());
    else computeColin().then(function (s) {
      if (!overlay) return;
      paint(s ? realTiles(s) : { tiles: [["—", "No data yet"]], line: "Stats will appear once the season data is complete." });
    }).catch(function () { if (overlay) paint({ tiles: [["—", "—"]], line: "Couldn’t load the stats just now — try again shortly." }); });
  }

  // which temporary screen is active right now. Both windows are short-term and
  // self-retiring: Championship Mode runs from the Finals-countdown days through
  // Aug 8, the Colin tribute shows only on Aug 9 — after that nothing shows again.
  function phase() {
    var now = Date.now();
    if (now >= Date.parse(COLIN_AFTER) && now < Date.parse(COLIN_END)) return "colin";
    if (now < Date.parse(COLIN_AFTER)) {
      var m = modeForDate(todayET());
      if (isEventDay(m)) return "champ"; // Aug 6–8, the real Prelims/Semis/Finals screens
      if (m === "pre") return "champ";   // the run-up: the live Finals countdown
    }
    return "none";
  }

  // short-lived preview of the end-of-season tribute LAYOUT (nameless placeholder)
  function mockPreviewActive() {
    return !!PREVIEW_MOCK_UNTIL && Date.now() < Date.parse(PREVIEW_MOCK_UNTIL);
  }

  // ---- open ------------------------------------------------------------------
  function markSeenToday() { lset("cad-cm-seen-" + todayET(), "1"); }

  function open(mode) {
    injectStyles();
    if (overlay) close();
    curMode = mode;
    lastFocus = document.activeElement;
    overlay = document.createElement("div");
    overlay.className = "cm-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "cm-h");
    overlay.innerHTML = '<div class="cm-backdrop"></div><div class="cm-card">' + headHtml(mode) + '<div class="cm-body"></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector(".cm-x").addEventListener("click", function () { markSeenToday(); close(); });
    renderIntro(mode);
    if (VIEW[mode].countdown) { updateCountdown(); cdTimer = setInterval(updateCountdown, 1000); }
    document.addEventListener("keydown", onKey, true);
    // focus into the modal for keyboard + screen-reader users
    var f = overlay.querySelector("#cm-enter") || overlay.querySelector(".cm-x");
    if (f) setTimeout(function () { try { f.focus(); } catch (e) {} }, 30);
  }

  // ---- auto-show + "show again" ----------------------------------------------
  function maybeAutoShow() {
    // top priority: the short-lived tribute-layout preview. Re-shows on every
    // fresh page load until it expires (no session guard) so it's easy to catch.
    if (mockPreviewActive()) {
      openColin({ mock: true });
      return;
    }
    var ph = phase();
    if (ph === "none") return;
    try { if (sessionStorage.getItem("cad-cm-session")) return; } catch (e) {} // once per session
    if (ph === "colin") {                                // after Finals: reveal the tribute once
      if (lget("cad-cm-colin-seen")) return;
      try { sessionStorage.setItem("cad-cm-session", "1"); } catch (e) {}
      lset("cad-cm-colin-seen", "1");
      openColin({ mock: false });
      return;
    }
    // Aug 6–8: Championship Mode, first open each day
    if (lget("cad-cm-seen-" + todayET())) return;
    try { sessionStorage.setItem("cad-cm-session", "1"); } catch (e) {}
    markSeenToday();
    open(modeForDate(todayET()));
  }

  // A gold button beside the settings gear that reopens whichever temporary
  // screen is live: the current day's Championship Mode (Aug 6–8), or the Colin
  // tribute (Finals night → COLIN_END). It disappears entirely once both windows
  // are over. During either window it always resets to the current information.
  var TROPHY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a3 3 0 0 1-3 3.5M7 5H4v2a3 3 0 0 0 3 3.5"/></svg>';
  var HEART_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M12 21s-7.5-4.9-10-9.2C.6 9 1.6 5.6 4.6 4.7 6.7 4 8.8 4.9 12 8c3.2-3.1 5.3-4 7.4-3.3 3 0.9 4 4.3 2.6 7.1C19.5 16.1 12 21 12 21z"/></svg>';
  function injectTopButton() {
    var mock = mockPreviewActive();
    var ph = phase();
    // shown while a temporary screen is live; also whenever dev-preview is on so
    // the developer can see/test the button before the trip
    if (!mock && ph === "none" && lget("cad-cm-dev") !== "1") return;
    var bar = document.querySelector("header.topbar");
    if (!bar || document.getElementById("cm-topbtn")) return;
    injectStyles();
    var isColin = !mock && ph === "colin";
    var btn = document.createElement("button");
    btn.id = "cm-topbtn";
    btn.type = "button";
    btn.title = mock ? "Preview: end-of-season screen" : isColin ? "Congratulations Colin Besel" : "DCI Championship Mode";
    btn.setAttribute("aria-label", mock ? "Open the season preview" : isColin ? "Open the Colin Besel tribute" : "Open Championship Mode");
    btn.innerHTML = isColin ? HEART_SVG : TROPHY_SVG; // mock uses the neutral trophy
    var gear = document.getElementById("settingsBtn");
    if (gear) bar.insertBefore(btn, gear); else bar.appendChild(btn);
    btn.addEventListener("click", function () {
      try { sessionStorage.setItem("cad-cm-session", "1"); } catch (e) {}
      if (mockPreviewActive()) openColin({ mock: true });
      else if (phase() === "colin") openColin({ mock: false });
      else open(modeForDate(todayET()));
    });
  }

  // ---- hidden developer preview (enable with ?cmdev=1) -----------------------
  function devFlow(kind) {
    var m = kind === "finals" ? "finals" : kind === "semis" ? "semis" : kind === "prelims" ? "prelims" : "pre";
    if (kind === "colinmock") { openColin({ mock: true }); return; }
    if (kind === "colinlive") { openColin({ mock: false }); return; }
    if (kind === "accept") { open("finals"); renderConfirm("finals"); overlay.querySelector("#cm-accept").focus(); return; }
    if (kind === "deny") { open("finals"); renderConfirm("finals"); renderDeny("finals"); return; }
    if (kind === "missions") {
      open("prelims");
      var date = dateForMode("prelims");
      lset("cad-cm-mdone-" + date, ""); // allow the celebration to fire again
      saveMissions(date, [true, true, true]);
      renderIntro("prelims");
      missionsComplete();
      return;
    }
    open(m);
  }
  function injectDevPanel() {
    var enabled = /[?&]cmdev=1\b/.test(location.search) || lget("cad-cm-dev") === "1";
    if (/[?&]cmdev=1\b/.test(location.search)) lset("cad-cm-dev", "1");
    if (/[?&]cmdev=0\b/.test(location.search)) { lset("cad-cm-dev", ""); enabled = false; }
    if (!enabled || document.getElementById("cm-dev")) return;
    injectStyles();
    var d = document.createElement("details");
    d.id = "cm-dev";
    d.innerHTML = '<summary title="Championship Mode preview (dev)">CM ▾</summary>' +
      '<div class="cm-devbox">' +
      '<button data-k="pre">Countdown (before 6th)</button>' +
      '<button data-k="prelims">Prelims (Aug 6)</button>' +
      '<button data-k="semis">Semifinals (Aug 7)</button>' +
      '<button data-k="finals">Finals (Aug 8)</button>' +
      "<hr>" +
      '<button data-k="accept">Accept flow</button>' +
      '<button data-k="deny">Deny flow</button>' +
      '<button data-k="missions">Missions confetti</button>' +
      "<hr>" +
      '<button data-k="colinmock">Colin tribute (mockup)</button>' +
      '<button data-k="colinlive">Colin tribute (live data)</button>' +
      "<hr>" +
      '<button data-k="reset">Reset saved state</button>' +
      '<button data-k="off">Hide this panel</button>' +
      "</div>";
    document.body.appendChild(d);
    d.querySelector(".cm-devbox").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      var k = b.dataset.k;
      d.open = false;
      if (k === "off") { lset("cad-cm-dev", ""); d.remove(); return; }
      if (k === "reset") {
        ["2026-08-06", "2026-08-07", "2026-08-08"].forEach(function (dt) {
          lset("cad-cm-missions-" + dt, ""); lset("cad-cm-mdone-" + dt, ""); lset("cad-cm-seen-" + dt, "");
        });
        lset("cad-cm-colin-seen", "");
        try { sessionStorage.removeItem("cad-cm-session"); } catch (er) {}
        alert("Championship Mode: saved missions / seen / tribute flags cleared.");
        return;
      }
      devFlow(k);
    });
  }

  // ---- boot ------------------------------------------------------------------
  function init() {
    try { injectDevPanel(); } catch (e) {}
    try { injectTopButton(); } catch (e) {}
    try { maybeAutoShow(); } catch (e) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.CadChamp = { open: open, close: close, mode: function () { return modeForDate(todayET()); } };
})();
