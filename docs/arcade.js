/* Cadence — hidden mini-game arcade (a little easter egg).
   Double-tap the Cadence logo to open it, then pick a game:
     • Keep the Beat — tap when the sweeping marker is in the gold zone.
     • Copy the Cadence — repeat the drumline pattern; it grows each round.
   Self-contained, synthesized drum hits via Web Audio, reuses the app's CSS
   variables. Namespaced (.ar-* / cad-ar-* / window.CadArcade). */
(function () {
  "use strict";
  function lget(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  // haptics (Android; no-ops on iOS, which doesn't expose the Vibration API)
  function haptic(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }

  // ---- sound (lazy — needs a user gesture) -----------------------------------
  var actx;
  function ctx() {
    if (actx === undefined) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; } }
    if (actx && actx.state === "suspended") { try { actx.resume(); } catch (e) {} }
    return actx;
  }
  function snare() {
    var a = ctx(); if (!a) return;
    var len = Math.floor(a.sampleRate * 0.14), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
    var n = a.createBufferSource(); n.buffer = buf;
    var f = a.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 1400;
    var g = a.createGain(); g.gain.setValueAtTime(0.45, a.currentTime); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.14);
    n.connect(f); f.connect(g); g.connect(a.destination); n.start();
    var o = a.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(190, a.currentTime); o.frequency.exponentialRampToValueAtTime(60, a.currentTime + 0.13);
    var g2 = a.createGain(); g2.gain.setValueAtTime(0.5, a.currentTime); g2.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.16);
    o.connect(g2); g2.connect(a.destination); o.start(); o.stop(a.currentTime + 0.18);
  }
  function womp() {
    var a = ctx(); if (!a) return;
    var o = a.createOscillator(); o.type = "sawtooth"; o.frequency.setValueAtTime(220, a.currentTime); o.frequency.exponentialRampToValueAtTime(70, a.currentTime + 0.22);
    var g = a.createGain(); g.gain.setValueAtTime(0.28, a.currentTime); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.24);
    o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.26);
  }
  function tone(freq) {
    var a = ctx(); if (!a) return;
    var o = a.createOscillator(); o.type = "triangle"; o.frequency.value = freq;
    var g = a.createGain(); g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.32, a.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.34);
    o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.36);
  }

  // ---- styles ----------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById("ar-style")) return;
    var css = [
      ".ar-overlay{position:fixed;inset:0;z-index:3200;display:flex;align-items:center;justify-content:center;padding:16px;}",
      ".ar-backdrop{position:absolute;inset:0;background:rgba(8,20,38,.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);}",
      ".ar-card{position:relative;z-index:3;width:100%;max-width:400px;background:var(--surface-1);color:var(--text-primary);border:1px solid var(--border);border-radius:20px;box-shadow:0 24px 70px rgba(8,20,38,.55);overflow:hidden;}",
      ".ar-head{background:var(--navy);color:#fff;padding:18px 20px 16px;text-align:center;position:relative;}",
      ".ar-x{position:absolute;top:10px;right:10px;width:34px;height:34px;border:0;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;font-size:20px;line-height:1;cursor:pointer;display:grid;place-items:center;}",
      ".ar-x:hover{background:rgba(255,255,255,.26);}",
      ".ar-eyebrow{font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:var(--gold);}",
      ".ar-title{font-size:25px;font-weight:900;letter-spacing:-.5px;margin:5px 0 0;color:#fff;}",
      ".ar-sub{font-size:12.5px;color:rgba(255,255,255,.8);margin-top:3px;}",
      ".ar-body{padding:16px 20px 20px;}",
      // menu
      ".ar-menu{display:flex;flex-direction:column;gap:10px;}",
      ".ar-game{display:flex;align-items:center;gap:14px;text-align:left;width:100%;font:inherit;background:var(--surface-2);border:1px solid var(--border);border-radius:14px;padding:14px;cursor:pointer;color:var(--text-primary);}",
      ".ar-game:hover{border-color:var(--muted);}",
      ".ar-gico{font-size:30px;line-height:1;flex:0 0 auto;}",
      ".ar-gname{font-size:16px;font-weight:800;}",
      ".ar-gdesc{font-size:12.5px;color:var(--muted);margin-top:2px;line-height:1.35;}",
      ".ar-gbest{margin-left:auto;font-size:11px;font-weight:800;color:var(--gold);text-transform:uppercase;letter-spacing:.4px;flex:0 0 auto;white-space:nowrap;}",
      // shared HUD
      ".ar-hud{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;font-variant-numeric:tabular-nums;}",
      ".ar-score{font-size:15px;font-weight:800;color:var(--text-primary);}",
      ".ar-score span{color:var(--muted);font-weight:700;}",
      ".ar-lives{font-size:16px;letter-spacing:2px;}",
      ".ar-status{font-size:14px;font-weight:800;color:var(--text-primary);}",
      // Keep the Beat
      ".ar-track{position:relative;height:52px;border-radius:14px;background:var(--surface-2);border:1px solid var(--border);overflow:hidden;cursor:pointer;touch-action:manipulation;}",
      ".ar-zone{position:absolute;top:0;bottom:0;background:linear-gradient(180deg,rgba(240,180,41,.5),rgba(240,180,41,.28));border-left:2px solid var(--gold);border-right:2px solid var(--gold);transition:left .12s ease,width .12s ease;}",
      ".ar-marker{position:absolute;top:-2px;bottom:-2px;width:4px;border-radius:3px;background:#fff;box-shadow:0 0 10px rgba(255,255,255,.8);transform:translateX(-50%);}",
      ".ar-flash{position:absolute;inset:0;pointer-events:none;opacity:0;}",
      ".ar-flash.hit{background:rgba(47,158,68,.28);animation:ar-fl .25s ease;}",
      ".ar-flash.miss{background:rgba(224,49,49,.3);animation:ar-fl .3s ease;}",
      "@keyframes ar-fl{from{opacity:1}to{opacity:0}}",
      // Copy the Cadence pads
      ".ar-pads{display:grid;grid-template-columns:1fr 1fr;gap:10px;}",
      ".ar-pad{aspect-ratio:1/1;border:0;border-radius:16px;cursor:pointer;opacity:.42;color:#fff;transition:opacity .09s,transform .06s;touch-action:manipulation;}",
      ".ar-pad.lit{opacity:1;transform:scale(1.03);box-shadow:0 0 26px currentColor;}",
      ".ar-pad:active{transform:scale(.97);}",
      // buttons + result
      ".ar-btn{display:block;width:100%;margin-top:14px;border:0;border-radius:999px;padding:15px;font:inherit;font-size:17px;font-weight:900;letter-spacing:.5px;cursor:pointer;background:var(--gold);color:#16233d;}",
      ".ar-btn:active{transform:translateY(1px);}",
      ".ar-btn.ghost{background:var(--surface-2);color:var(--text-primary);border:1px solid var(--border);font-size:14px;font-weight:800;letter-spacing:0;padding:11px;margin-top:8px;}",
      ".ar-hint{text-align:center;font-size:13px;color:var(--muted);margin:12px 2px 0;line-height:1.4;}",
      ".ar-big{text-align:center;padding:6px 0 2px;}",
      ".ar-big b{display:block;font-size:40px;font-weight:900;color:var(--text-primary);font-variant-numeric:tabular-nums;line-height:1;}",
      ".ar-big span{display:block;font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-top:6px;}",
      "@media (prefers-reduced-motion: reduce){.ar-flash.hit,.ar-flash.miss,.ar-pad{animation:none;transition:none;}}"
    ].join("\n");
    var st = document.createElement("style"); st.id = "ar-style"; st.textContent = css; document.head.appendChild(st);
  }

  // ---- overlay plumbing ------------------------------------------------------
  var overlay = null, raf = null, onKey = null, run = 0, timers = [];
  function after(ms, fn) { var id = setTimeout(fn, ms); timers.push(id); return id; }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; if (raf) { cancelAnimationFrame(raf); raf = null; } }
  function close() {
    run++; clearTimers();
    if (onKey) { document.removeEventListener("keydown", onKey, true); onKey = null; }
    if (overlay) { overlay.remove(); overlay = null; }
  }
  function head(title, sub) {
    return '<div class="ar-head"><button class="ar-x" type="button" aria-label="Close">×</button>' +
      '<div class="ar-eyebrow">Cadence Arcade</div><div class="ar-title">' + title + "</div>" +
      (sub ? '<div class="ar-sub">' + sub + "</div>" : "") + "</div>";
  }
  function setHead(title, sub) {
    if (!overlay) return;
    overlay.querySelector(".ar-title").textContent = title;
    var s = overlay.querySelector(".ar-sub"); if (s) s.textContent = sub || "";
  }
  function body() { return overlay.querySelector("#ar-body"); }
  function best(k) { return +(lget(k) || 0); }
  function saveBest(k, v) { if (v > best(k)) { lset(k, String(v)); return true; } return false; }

  function open() {
    injectStyles();
    ctx(); // unlock Web Audio on the opening tap (a user gesture) so the
           // memory game's auto-played pattern is actually audible
    if (overlay) close();
    overlay = document.createElement("div");
    overlay.className = "ar-overlay";
    overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-label", "Cadence Arcade");
    overlay.innerHTML = '<div class="ar-backdrop"></div><div class="ar-card">' + head("Cadence Arcade", "Pick a game") + '<div class="ar-body" id="ar-body"></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector(".ar-backdrop").addEventListener("click", close);
    overlay.querySelector(".ar-x").addEventListener("click", close);
    onKey = function (e) {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if ((e.key === " " || e.code === "Space") && beat.on) { e.preventDefault(); beat.tap(); }
    };
    document.addEventListener("keydown", onKey, true);
    menu();
  }

  function menu() {
    run++; clearTimers(); beat.on = false;
    setHead("Cadence Arcade", "Pick a game");
    var b1 = best("cad-ar-best"), b2 = best("cad-ar-best-simon");
    body().innerHTML =
      '<div class="ar-menu">' +
      '<button class="ar-game" data-g="beat" type="button"><div class="ar-gico">🥁</div>' +
      '<div><div class="ar-gname">Keep the Beat</div><div class="ar-gdesc">Tap when the marker is in the gold zone.</div></div>' +
      (b1 ? '<div class="ar-gbest">Best ' + b1 + "</div>" : "") + "</button>" +
      '<button class="ar-game" data-g="simon" type="button"><div class="ar-gico">🎯</div>' +
      '<div><div class="ar-gname">Copy the Cadence</div><div class="ar-gdesc">Repeat the drumline pattern — it grows each round.</div></div>' +
      (b2 ? '<div class="ar-gbest">Best ' + b2 + "</div>" : "") + "</button>" +
      "</div>";
    Array.prototype.forEach.call(body().querySelectorAll(".ar-game"), function (g) {
      g.addEventListener("click", function () { g.dataset.g === "simon" ? simon.start() : beat.start(); });
    });
  }
  function backBtn() {
    var el = body().querySelector("#ar-menu"); if (el) el.addEventListener("click", menu);
  }

  // ---- Game 1: Keep the Beat -------------------------------------------------
  var beat = {
    on: false, pos: 0, dir: 1, speed: 0, zoneC: 0.5, zoneW: 0.2, score: 0, lives: 3, last: null,
    start: function () {
      var b = this; b.on = true; b.pos = 0; b.dir = 1; b.speed = 0.55; b.zoneC = 0.5; b.zoneW = 0.2; b.score = 0; b.lives = 3; b.last = null;
      setHead("Keep the Beat", "");
      body().innerHTML =
        '<div class="ar-hud"><div class="ar-score">Score <span id="ar-scv">0</span></div><div class="ar-lives" id="ar-lv"></div></div>' +
        '<div class="ar-track" id="ar-track"><div class="ar-zone" id="ar-zone"></div><div class="ar-marker" id="ar-marker"></div><div class="ar-flash" id="ar-flash"></div></div>' +
        '<button class="ar-btn" id="ar-tap" type="button">TAP</button>' +
        '<p class="ar-hint">Space or tapping the bar works too.</p>';
      body().querySelector("#ar-tap").addEventListener("click", function () { b.tap(); });
      body().querySelector("#ar-track").addEventListener("click", function () { b.tap(); });
      b.hud(); b.zone(); b.loop();
    },
    hud: function () { var lv = overlay.querySelector("#ar-lv"), sc = overlay.querySelector("#ar-scv"); if (lv) lv.textContent = "❤️".repeat(this.lives) + "🖤".repeat(3 - this.lives); if (sc) sc.textContent = this.score; },
    zone: function () { var z = overlay.querySelector("#ar-zone"); if (z) { z.style.left = ((this.zoneC - this.zoneW / 2) * 100) + "%"; z.style.width = (this.zoneW * 100) + "%"; } },
    loop: function () {
      var b = this, my = run;
      raf = requestAnimationFrame(function step(t) {
        if (!b.on || my !== run) return;
        if (b.last == null) b.last = t;
        var dt = Math.min(0.05, (t - b.last) / 1000); b.last = t;
        b.pos += b.dir * b.speed * dt;
        if (b.pos >= 1) { b.pos = 1; b.dir = -1; } else if (b.pos <= 0) { b.pos = 0; b.dir = 1; }
        var m = overlay.querySelector("#ar-marker"); if (m) m.style.left = (b.pos * 100) + "%";
        raf = requestAnimationFrame(step);
      });
    },
    flash: function (k) { var f = overlay.querySelector("#ar-flash"); if (!f) return; f.className = "ar-flash"; void f.offsetWidth; f.className = "ar-flash " + k; },
    tap: function () {
      if (!this.on) return;
      if (Math.abs(this.pos - this.zoneC) <= this.zoneW / 2) {
        this.score++; snare(); haptic(18); this.flash("hit");
        this.speed = Math.min(2.4, this.speed + 0.11);
        this.zoneW = Math.max(0.07, this.zoneW * 0.93);
        this.zoneC = 0.18 + Math.random() * 0.64;
        this.zone(); this.hud();
      } else {
        this.lives--; womp(); haptic([25, 45, 25]); this.flash("miss"); this.hud();
        if (this.lives <= 0) this.over();
      }
    },
    over: function () {
      this.on = false; if (raf) { cancelAnimationFrame(raf); raf = null; }
      var isBest = saveBest("cad-ar-best", this.score), s = this.score;
      setHead("Keep the Beat", "");
      body().innerHTML =
        '<div class="ar-big"><b>' + s + "</b><span>" + (isBest ? "New best! 🎉" : "Best " + best("cad-ar-best")) + "</span></div>" +
        '<p class="ar-hint">' + beatBlurb(s) + "</p>" +
        '<button class="ar-btn" id="ar-again" type="button">PLAY AGAIN</button>' +
        '<button class="ar-btn ghost" id="ar-menu" type="button">← Games</button>';
      var self = this;
      body().querySelector("#ar-again").addEventListener("click", function () { self.start(); });
      backBtn();
    }
  };
  function beatBlurb(s) { return s >= 25 ? "Drum major material. 🥇" : s >= 15 ? "Locked in — clean hands!" : s >= 8 ? "Solid rep. Keep marking time." : s >= 3 ? "Not bad — run it back." : "Everybody starts at the beginning."; }

  // ---- Game 2: Copy the Cadence (Simon, with growing color levels) -----------
  // Six colors, each with its own note (a rising scale). Start with 4 pads; a
  // new color unlocks every 4 rounds, up to all 6 — so the board grows as you go.
  var PADS = [
    { c: "#1971c2", f: 262 }, { c: "#2f9e44", f: 294 }, { c: "#f0b429", f: 330 },
    { c: "#d2222d", f: 392 }, { c: "#7048e8", f: 440 }, { c: "#0c8599", f: 523 }
  ];
  var SIMON_PADS = PADS.length; // always play with all six colors
  var simon = {
    seq: [], step: 0, accepting: false, round: 0, lives: 3,
    start: function () {
      run++; clearTimers(); ctx(); // fresh run, unlock audio on this tap
      this.seq = []; this.round = 0; this.accepting = false; this.lives = 3;
      setHead("Copy the Cadence", "");
      body().innerHTML =
        '<div class="ar-hud"><div class="ar-score">Round <span id="ar-rnd">0</span></div><div class="ar-lives" id="ar-lv"></div></div>' +
        '<div class="ar-status" id="ar-st" style="text-align:center;margin:2px 0 12px">Get ready…</div>' +
        '<div class="ar-pads" id="ar-pads"></div>' +
        '<p class="ar-hint">Watch the lit pattern (with sound), then tap it back. Three lives — a slip just replays the pattern.</p>';
      this.renderPads();
      this.lifeHud();
      this.next();
    },
    renderPads: function () {
      var pads = overlay.querySelector("#ar-pads");
      pads.style.gridTemplateColumns = "1fr 1fr 1fr";
      pads.innerHTML = PADS.map(function (p, i) {
        return '<button class="ar-pad" data-i="' + i + '" type="button" aria-label="pad ' + (i + 1) + '" style="background:' + p.c + ';color:' + p.c + '"></button>';
      }).join("");
      var self = this;
      Array.prototype.forEach.call(pads.querySelectorAll(".ar-pad"), function (pad) {
        pad.addEventListener("click", function () { self.tap(+pad.dataset.i); });
      });
    },
    lite: function (i, on) { var pad = overlay && overlay.querySelector('.ar-pad[data-i="' + i + '"]'); if (pad) pad.classList.toggle("lit", !!on); },
    setStatus: function (txt) { var s = overlay && overlay.querySelector("#ar-st"); if (s) s.textContent = txt; },
    setRound: function () { var r = overlay && overlay.querySelector("#ar-rnd"); if (r) r.textContent = this.round; },
    lifeHud: function () { var lv = overlay && overlay.querySelector("#ar-lv"); if (lv) lv.textContent = "❤️".repeat(Math.max(0, this.lives)) + "🖤".repeat(Math.max(0, 3 - this.lives)); },
    next: function () {
      this.round++; this.setRound();
      this.seq.push(Math.floor(Math.random() * SIMON_PADS));
      this.replay();
    },
    replay: function () { this.step = 0; this.accepting = false; this.play(); },
    play: function () {
      var self = this, my = run, i = 0;
      this.setStatus("Watch…");
      (function playNext() {
        if (my !== run) return;
        if (i >= self.seq.length) { self.accepting = true; self.setStatus("Your turn"); return; }
        var idx = self.seq[i++];
        self.lite(idx, true); tone(PADS[idx].f);
        after(440, function () { self.lite(idx, false); after(200, playNext); });
      })();
    },
    tap: function (i) {
      if (!this.accepting) return;
      var self = this;
      this.lite(i, true); tone(PADS[i].f); after(150, function () { self.lite(i, false); });
      if (i !== this.seq[this.step]) {            // wrong pad — costs a life
        this.accepting = false; womp(); haptic([25, 45, 25]); this.lives--; this.lifeHud();
        if (this.lives <= 0) { after(550, function () { self.over(); }); return; }
        this.setStatus("Oops — watch again");
        after(850, function () { self.replay(); }); // same pattern, another shot
        return;
      }
      haptic(12);
      this.step++;
      if (this.step >= this.seq.length) {         // round complete
        this.accepting = false; this.setStatus("Nice! ✓"); snare(); haptic([14, 40, 14]);
        after(650, function () { self.next(); });
      }
    },
    over: function () {
      this.accepting = false;
      var reached = this.round - 1;               // rounds fully completed
      var isBest = saveBest("cad-ar-best-simon", reached);
      setHead("Copy the Cadence", "");
      body().innerHTML =
        '<div class="ar-big"><b>' + reached + "</b><span>" + (isBest ? "New best! 🎉" : "Best " + best("cad-ar-best-simon")) + "</span></div>" +
        '<p class="ar-hint">' + simonBlurb(reached) + "</p>" +
        '<button class="ar-btn" id="ar-again" type="button">PLAY AGAIN</button>' +
        '<button class="ar-btn ghost" id="ar-menu" type="button">← Games</button>';
      var self = this;
      body().querySelector("#ar-again").addEventListener("click", function () { self.start(); });
      backBtn();
    },
    // tiny hook for testing the sequence deterministically
    _peek: function () { return { seq: this.seq.slice(), accepting: this.accepting, lives: this.lives }; }
  };
  function simonBlurb(r) { return r >= 14 ? "Photographic. 🧠🥇" : r >= 9 ? "Sharp ears!" : r >= 5 ? "Nice memory — keep going." : r >= 2 ? "Warming up…" : "Give it another shot."; }

  // ---- trigger: double-tap the logo ------------------------------------------
  function init() {
    var brand = document.querySelector("header.topbar .brand") || document.querySelector(".brand");
    if (!brand) return;
    var taps = [];
    brand.addEventListener("click", function () {
      var now = (window.performance && performance.now) ? performance.now() : +new Date();
      taps.push(now);
      taps = taps.filter(function (t) { return now - t < 450; }); // a quick double-tap
      if (taps.length >= 2) { taps = []; try { open(); } catch (e) {} }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.CadArcade = { open: open, close: close, _simon: simon };
})();
