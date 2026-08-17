/* Cadence Drill — the shared engine under the designer, the player and the
   dot book. Pure geometry + rendering; it owns no DOM outside the canvas it
   is handed and never talks to the network.

   Units: everything is in 8-to-5 steps (22.5" each). Football fields run
   x = -80 … 80 (Side 1 goal line to Side 2 goal line, 0 at the 50) and
   y = 0 … 85.33 (front sideline to back sideline). Indoor floors (WGI
   regulation 90' × 60') run x = -24 … 24 and y = 0 … 32, front edge at 0.

   A "show" object looks like:
     { title, field_type, tempo, performers: [{id,label,section,symbol,color}],
       sets: [{id,idx,name,counts,hold,tempo,notes,dots:{pid:[x,y]}}] }
   which is exactly the database shape, so save/load is a straight copy. */
(function () {
  "use strict";

  /* ── fields ─────────────────────────────────────────────────────────── */
  var STEP_IN = 22.5; // inches per 8-to-5 step
  var FB_W = 1920 / STEP_IN; // 85.333… steps between sidelines
  var FIELDS = {
    hs:      { name: "High school field", kind: "football", xMin: -80, xMax: 80, yMin: 0, yMax: FB_W,
               frontHash: 640 / STEP_IN,  backHash: FB_W - 640 / STEP_IN },   // 53'4" hashes
    college: { name: "College field",     kind: "football", xMin: -80, xMax: 80, yMin: 0, yMax: FB_W,
               frontHash: 720 / STEP_IN,  backHash: FB_W - 720 / STEP_IN },   // 60' hashes
    pro:     { name: "Pro field",         kind: "football", xMin: -80, xMax: 80, yMin: 0, yMax: FB_W,
               frontHash: 849 / STEP_IN,  backHash: FB_W - 849 / STEP_IN },   // 70'9" hashes
    indoor:  { name: "Indoor floor (60′ × 90′)", kind: "floor", xMin: -24, xMax: 24, yMin: 0, yMax: 32 },
  };

  /* ── marching-vocabulary coordinates ────────────────────────────────── */
  function fmtSteps(n) {
    var r = Math.round(n * 100) / 100;
    return (r === Math.round(r)) ? String(Math.round(r)) : String(r.toFixed(r * 10 % 1 ? 2 : 1));
  }
  // x: which yard line, which side, inside (toward 50) or outside (toward goal)
  function xText(x, field) {
    if (field.kind === "floor") {
      if (Math.abs(x) < 0.125) return "on the center line";
      return fmtSteps(Math.abs(x)) + " steps " + (x < 0 ? "left" : "right") + " of center";
    }
    var line = Math.round(x / 8) * 8;                     // nearest painted line
    if (line < field.xMin) line = field.xMin;
    if (line > field.xMax) line = field.xMax;
    var yard = 50 - Math.abs(line) / 1.6;                 // 8 steps = 5 yards
    var d = x - line;
    var side = (x < 0 || (x === 0 && line === 0)) ? "Side 1" : "Side 2";
    if (x === 0) return "on the 50";
    var lineName = yard === 0 ? "goal line" : String(yard) + " yd ln";
    if (Math.abs(d) < 0.125) return side + ": on the " + lineName;
    // inside = toward the 50; the sign of "toward 50" flips with the side of the field
    var toward50 = (x < 0) ? d > 0 : d < 0;
    // if the performer is past the goal line there is no "outside" line to name
    return side + ": " + fmtSteps(Math.abs(d)) + " steps " +
      (toward50 ? "inside" : "outside") + " " + lineName;
  }
  // y: nearest of front sideline / hashes / back sideline
  function yText(y, field) {
    if (field.kind === "floor") {
      if (y < 0.125) return "on the front edge";
      return fmtSteps(y) + " steps behind the front edge";
    }
    var refs = [
      { at: field.yMin, name: "front sideline" },
      { at: field.frontHash, name: "front hash" },
      { at: field.backHash, name: "back hash" },
      { at: field.yMax, name: "back sideline" },
    ];
    var best = refs[0];
    for (var i = 1; i < refs.length; i++)
      if (Math.abs(y - refs[i].at) < Math.abs(y - best.at)) best = refs[i];
    var d = y - best.at;
    if (Math.abs(d) < 0.125) return "on the " + best.name;
    return fmtSteps(Math.abs(d)) + " steps " + (d > 0 ? "behind" : "in front of") + " " + best.name;
  }
  function coordText(pos, field) {
    return { x: xText(pos[0], field), y: yText(pos[1], field) };
  }

  /* ── movement math ──────────────────────────────────────────────────── */
  function dist(a, b) { var dx = b[0] - a[0], dy = b[1] - a[1]; return Math.sqrt(dx * dx + dy * dy); }
  // "8 to 5" language: how many strides cover 5 yards at this move's pace
  function strideLabel(d, counts) {
    if (!counts || d < 0.25) return d < 0.25 ? "hold" : "jump";
    var k = 8 * counts / d;
    if (k > 32) return "mark time-ish (" + (Math.round(k * 10) / 10) + " to 5)";
    return (Math.round(k * 10) / 10) + " to 5";
  }
  function moveText(from, to, counts, field) {
    var d = dist(from, to);
    if (d < 0.25) return "Hold " + counts + " counts";
    var dx = to[0] - from[0], dy = to[1] - from[1];
    var parts = [];
    if (Math.abs(dy) >= 0.25) parts.push(fmtSteps(Math.abs(dy)) + (dy < 0 ? " forward" : " backward"));
    if (Math.abs(dx) >= 0.25)
      parts.push(fmtSteps(Math.abs(dx)) + " toward " +
        (field.kind === "floor" ? (dx < 0 ? "stage right" : "stage left") : (dx < 0 ? "Side 1" : "Side 2")));
    return parts.join(", ") + " in " + counts + " — " + strideLabel(d, counts);
  }

  /* interpolate a whole set transition at parameter t (0..1), straight paths */
  function lerpDots(a, b, t, out) {
    out = out || {};
    for (var id in b) {
      var p = a[id], q = b[id];
      if (!p) { out[id] = q.slice(); continue; }
      out[id] = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    }
    return out;
  }

  /* collisions: sample each transition per count; flag pairs closer than
     minDist steps. Returns [{set: idx of target set, count, a, b, d}] */
  function findCollisions(show, minDist) {
    minDist = minDist || 1.25;
    var hits = [], sets = show.sets;
    for (var s = 1; s < sets.length; s++) {
      var A = sets[s - 1].dots, B = sets[s].dots;
      var n = Math.max(2, sets[s].counts | 0);
      var ids = Object.keys(B);
      for (var c = 1; c <= n; c++) {
        var pos = lerpDots(A, B, c / n);
        for (var i = 0; i < ids.length; i++) {
          for (var j = i + 1; j < ids.length; j++) {
            var d = dist(pos[ids[i]], pos[ids[j]]);
            if (d < minDist) {
              hits.push({ set: s, count: c, a: ids[i], b: ids[j], d: Math.round(d * 100) / 100 });
              if (hits.length > 400) return hits; // enough to make the point
            }
          }
        }
      }
    }
    return hits;
  }

  /* ── form tools: place N points on a shape ──────────────────────────── */
  function onLine(a, b, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = n === 1 ? 0.5 : i / (n - 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    return out;
  }
  function onArc(center, r, a0, a1, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = n === 1 ? 0.5 : i / (n - 1);
      var a = a0 + (a1 - a0) * t;
      out.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
    }
    return out;
  }
  function onCircle(center, r, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / n;
      out.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
    }
    return out;
  }
  function onBlock(origin, cols, rows, dx, dy, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var r = Math.floor(i / cols), c = i % cols;
      out.push([origin[0] + c * dx, origin[1] + r * dy]);
    }
    return out;
  }
  function rotatePts(pts, center, angle) {
    var s = Math.sin(angle), c = Math.cos(angle);
    return pts.map(function (p) {
      var x = p[0] - center[0], y = p[1] - center[1];
      return [center[0] + x * c - y * s, center[1] + x * s + y * c];
    });
  }
  function scalePts(pts, center, k) {
    return pts.map(function (p) {
      return [center[0] + (p[0] - center[0]) * k, center[1] + (p[1] - center[1]) * k];
    });
  }
  function centroid(pts) {
    var x = 0, y = 0;
    pts.forEach(function (p) { x += p[0]; y += p[1]; });
    return pts.length ? [x / pts.length, y / pts.length] : [0, 0];
  }

  /* ── view transform + renderer ──────────────────────────────────────── */
  function makeView(canvas, field, pad) {
    pad = pad == null ? 26 : pad;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var fw = field.xMax - field.xMin, fh = field.yMax - field.yMin;
    var k = Math.min((w - pad * 2) / fw, (h - pad * 2) / fh);
    return {
      k: k,
      ox: (w - k * fw) / 2 - field.xMin * k,
      oy: (h - k * fh) / 2 - field.yMin * k,
      toPx: function (p) { return [p[0] * this.k + this.ox, p[1] * this.k + this.oy]; },
      toStep: function (px, py) { return [(px - this.ox) / this.k, (py - this.oy) / this.k]; },
    };
  }

  function sizeCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function themeColors() {
    var s = getComputedStyle(document.documentElement);
    function v(name, fb) { var x = s.getPropertyValue(name).trim(); return x || fb; }
    return {
      turf: v("--drill-turf", "#2e7d46"), turf2: v("--drill-turf2", "#2a733f"),
      line: "rgba(255,255,255,0.85)", faint: "rgba(255,255,255,0.28)",
      num: "rgba(255,255,255,0.65)", hash: "rgba(255,255,255,0.7)",
      floor: v("--drill-floor", "#3b4252"), floorLine: "rgba(255,255,255,0.25)",
    };
  }

  function drawField(ctx, view, field, opts) {
    opts = opts || {};
    var C = themeColors();
    var tl = view.toPx([field.xMin, field.yMin]), br = view.toPx([field.xMax, field.yMax]);
    ctx.save();
    if (field.kind === "floor") {
      ctx.fillStyle = C.floor;
      ctx.fillRect(tl[0], tl[1], br[0] - tl[0], br[1] - tl[1]);
      ctx.strokeStyle = C.floorLine; ctx.lineWidth = 1;
      // a quiet 4-step grid so shapes have something to hang on
      for (var gx = field.xMin; gx <= field.xMax; gx += 4) {
        var p = view.toPx([gx, field.yMin]), q = view.toPx([gx, field.yMax]);
        ctx.globalAlpha = gx === 0 ? 0.8 : 0.35;
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
      }
      for (var gy = field.yMin; gy <= field.yMax; gy += 4) {
        var p2 = view.toPx([field.xMin, gy]), q2 = view.toPx([field.xMax, gy]);
        ctx.globalAlpha = 0.35;
        ctx.beginPath(); ctx.moveTo(p2[0], p2[1]); ctx.lineTo(q2[0], q2[1]); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = C.line; ctx.lineWidth = 2;
      ctx.strokeRect(tl[0], tl[1], br[0] - tl[0], br[1] - tl[1]);
      ctx.restore();
      return;
    }
    // turf with alternating 5-yard bands
    for (var x = field.xMin; x < field.xMax; x += 8) {
      var a = view.toPx([x, field.yMin]), b = view.toPx([x + 8, field.yMax]);
      ctx.fillStyle = (Math.round((x + 80) / 8) % 2) ? C.turf : C.turf2;
      ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    }
    // yard lines
    for (var lx = field.xMin; lx <= field.xMax; lx += 8) {
      var p3 = view.toPx([lx, field.yMin]), q3 = view.toPx([lx, field.yMax]);
      ctx.strokeStyle = C.line; ctx.lineWidth = (lx === 0 || Math.abs(lx) === 80) ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(p3[0], p3[1]); ctx.lineTo(q3[0], q3[1]); ctx.stroke();
    }
    // step grid (optional, editor)
    if (opts.grid && view.k > 5) {
      ctx.strokeStyle = C.faint; ctx.lineWidth = 0.5;
      for (var sx = field.xMin; sx <= field.xMax; sx += 4) {
        if (sx % 8 === 0) continue;
        var p4 = view.toPx([sx, field.yMin]), q4 = view.toPx([sx, field.yMax]);
        ctx.beginPath(); ctx.moveTo(p4[0], p4[1]); ctx.lineTo(q4[0], q4[1]); ctx.stroke();
      }
      for (var sy = 0; sy <= field.yMax; sy += 4) {
        var p5 = view.toPx([field.xMin, sy]), q5 = view.toPx([field.xMax, sy]);
        ctx.beginPath(); ctx.moveTo(p5[0], p5[1]); ctx.lineTo(q5[0], q5[1]); ctx.stroke();
      }
    }
    // hashes
    ctx.strokeStyle = C.hash; ctx.lineWidth = 1.5;
    [field.frontHash, field.backHash].forEach(function (hy) {
      for (var hx = field.xMin; hx <= field.xMax; hx += 8) {
        var p6 = view.toPx([hx - 0.6, hy]), q6 = view.toPx([hx + 0.6, hy]);
        ctx.beginPath(); ctx.moveTo(p6[0], p6[1]); ctx.lineTo(q6[0], q6[1]); ctx.stroke();
      }
    });
    // yard numbers, both readable orientations
    if (view.k > 3.2) {
      ctx.fillStyle = C.num;
      ctx.font = "700 " + Math.max(9, view.k * 2.2) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      for (var nx = -64; nx <= 64; nx += 16) {
        var yard = 50 - Math.abs(nx) / 1.6;
        if (yard <= 0) continue;
        var lbl = String(yard);
        var pf = view.toPx([nx, 12]);
        ctx.fillText(lbl, pf[0], pf[1]);
        var pb = view.toPx([nx, field.yMax - 12]);
        ctx.save(); ctx.translate(pb[0], pb[1]); ctx.rotate(Math.PI); ctx.fillText(lbl, 0, 0); ctx.restore();
      }
    }
    ctx.restore();
  }

  function drawSymbol(ctx, x, y, r, symbol) {
    ctx.beginPath();
    if (symbol === "square") ctx.rect(x - r, y - r, 2 * r, 2 * r);
    else if (symbol === "triangle") {
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath();
    } else if (symbol === "x") {
      ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
    } else if (symbol === "star") {
      for (var i = 0; i < 10; i++) {
        var rr = i % 2 ? r * 0.45 : r;
        var a = -Math.PI / 2 + i * Math.PI / 5;
        var px = x + rr * Math.cos(a), py = y + rr * Math.sin(a);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
    } else ctx.arc(x, y, r, 0, 2 * Math.PI);
  }

  /* dots: positions {pid:[x,y]}; performers indexed by id for look/label */
  function drawDots(ctx, view, performers, dots, opts) {
    opts = opts || {};
    var byId = {};
    performers.forEach(function (p) { byId[p.id] = p; });
    var r = Math.max(3.2, Math.min(8, view.k * 0.62));
    // ghost layer (previous set + movement lines)
    if (opts.ghosts) {
      ctx.save(); ctx.globalAlpha = 0.4;
      for (var gid in opts.ghosts) {
        if (!dots[gid]) continue;
        var g = view.toPx(opts.ghosts[gid]), n2 = view.toPx(dots[gid]);
        ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(g[0], g[1]); ctx.lineTo(n2[0], n2[1]); ctx.stroke();
        ctx.setLineDash([]);
        var gp = byId[gid];
        ctx.strokeStyle = (gp && gp.color) || "#ccc"; ctx.lineWidth = 1.4;
        drawSymbol(ctx, g[0], g[1], r * 0.7, gp && gp.symbol);
        ctx.stroke();
      }
      ctx.restore();
    }
    performers.forEach(function (p) {
      var pos = dots[p.id];
      if (!pos) return;
      var q = view.toPx(pos);
      var sel = opts.selection && opts.selection[p.id];
      var me = opts.highlight === p.id;
      ctx.save();
      if (me) {
        ctx.shadowColor = "#ffd43b"; ctx.shadowBlur = 14;
        ctx.fillStyle = "#ffd43b";
        ctx.beginPath(); ctx.arc(q[0], q[1], r + 4.5, 0, 2 * Math.PI); ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.fillStyle = p.color || "#1971c2";
      ctx.strokeStyle = sel ? "#ffd43b" : "rgba(0,0,0,0.55)";
      ctx.lineWidth = sel ? 2.6 : 1.1;
      drawSymbol(ctx, q[0], q[1], r, p.symbol);
      if (p.symbol === "x") { ctx.stroke(); }
      else { ctx.fill(); ctx.stroke(); }
      if (opts.labels && view.k > 4.2) {
        ctx.fillStyle = "#fff";
        ctx.font = "700 " + Math.max(8.5, r * 1.35) + "px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.shadowColor = "rgba(0,0,0,0.75)"; ctx.shadowBlur = 3;
        ctx.fillText(p.label, q[0], q[1] - r - 3.5);
      }
      ctx.restore();
    });
  }

  /* ── show plumbing ──────────────────────────────────────────────────── */
  function uid() {
    // real UUIDs, minted client-side, inserted as-is — so dots{} keys stay
    // stable across save/load and offline drafts sync without re-keying
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function newShow(title, fieldType) {
    return {
      title: title || "Untitled show", field_type: fieldType || "hs", tempo: 120,
      performers: [], sets: [{ id: uid(), idx: 0, name: "Set 1", counts: 0, hold: 0, notes: "", dots: {} }],
    };
  }
  function cloneDots(dots) {
    var out = {};
    for (var k in dots) out[k] = dots[k].slice();
    return out;
  }

  /* local drafts — the designer works before any workspace exists */
  var DRAFT_KEY = "cad-drill-draft";
  function loadDraft() {
    try { var s = localStorage.getItem(DRAFT_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function saveDraft(show) {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(show)); return true; } catch (e) { return false; }
  }

  window.CadDrill = {
    FIELDS: FIELDS, STEP_IN: STEP_IN,
    coordText: coordText, xText: xText, yText: yText,
    dist: dist, strideLabel: strideLabel, moveText: moveText,
    lerpDots: lerpDots, findCollisions: findCollisions,
    onLine: onLine, onArc: onArc, onCircle: onCircle, onBlock: onBlock,
    rotatePts: rotatePts, scalePts: scalePts, centroid: centroid,
    makeView: makeView, sizeCanvas: sizeCanvas, drawField: drawField, drawDots: drawDots,
    uid: uid, newShow: newShow, cloneDots: cloneDots,
    loadDraft: loadDraft, saveDraft: saveDraft,
  };
})();
