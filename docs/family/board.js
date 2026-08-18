/* Cadence family — the alternate scoreboard for circuits where the DCI
   season trend line can't work.

   The DCI board plots score-by-date because a corps performs ~10 times a
   season against the same field. WGI publishes its live scores only through
   a directors-only portal, so there is no season score feed at all: the
   honest board is the championship record plus the official schedule. That
   is the "history" shape, and it is the only shape that ships.

   (Three other shapes — "event", "rating", "placement" — existed for the
   BOA / UIL / ISSMA apps. Those circuits were retired; the shapes and the
   ratings engine behind them are gone on purpose. See BOARD-CONTRACT.md.)

   Contract: window.CadBoard.render({app, data, stale, shape, cfg, helpers})
   — see family/BOARD-CONTRACT.md. Self-contained: no build step, escaping
   via window.CCViz (charts.js), styling via board.css next door. */
(function () {
  "use strict";

  /* board.css ships next to this file but the app shells don't link it —
     inject it once, resolved against this script's own URL. */
  (function injectCss() {
    if (typeof document === "undefined") return;
    if (document.querySelector("link[data-cad-board]")) return;
    const cs = document.currentScript;
    const href = cs && cs.src ? cs.src.replace(/board\.js[^/]*$/, "board.css") : "../family/board.css";
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-cad-board", "1");
    document.head.appendChild(link);
  })();

  /* ---------- tiny shared utilities ---------- */
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDY(iso) {
    if (!iso) return "";
    const p = String(iso).split("-").map(Number);
    return p.length >= 3 ? `${MONTHS[p[1] - 1]} ${p[2]}, ${p[0]}` : String(iso);
  }
  /* CCViz.esc covers text nodes but leaves double quotes alone — run
     already-escaped strings through this before putting them in attributes */
  const qa = s => String(s == null ? "" : s).replace(/"/g, "&quot;");

  const cap1 = s => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);

  /* ---------- champion record shaping ---------- */
  function titleRows(champions, cls) {
    const rows = [];
    for (const yr of Object.keys(champions || {})) {
      const c = champions[yr] && champions[yr][cls];
      if (c && c.corps) rows.push({ year: +yr, corps: c.corps, score: c.score });
    }
    return rows.sort((a, b) => b.year - a.year);
  }
  function titleCounts(champions, cls) {
    const byCorps = new Map();
    for (const yr of Object.keys(champions || {})) {
      const classes = cls ? [cls] : Object.keys(champions[yr] || {});
      for (const k of classes) {
        const c = champions[yr] && champions[yr][k];
        if (!c || !c.corps) continue;
        const t = byCorps.get(c.corps) || { corps: c.corps, titles: 0, years: [] };
        t.titles++;
        t.years.push(+yr);
        byCorps.set(c.corps, t);
      }
    }
    const rows = [...byCorps.values()];
    for (const r of rows) {
      r.years.sort((a, b) => a - b);
      r.first = r.years[0];
      r.latest = r.years[r.years.length - 1];
    }
    return rows.sort((x, y) => y.titles - x.titles || y.latest - x.latest || x.corps.localeCompare(y.corps));
  }

  /* ---------- shared table / tab chrome (same look as the engine's) ---------- */
  function collapseRows(tbody, n, noun, favs) {
    if (!tbody) return;
    const host = tbody.closest(".tscroll") || tbody.closest("table").parentElement;
    const old = host.nextElementSibling;
    if (old && old.classList && old.classList.contains("expandwrap")) old.remove();
    const rows = [...tbody.rows];
    if (rows.length <= n + 3) return;
    let open = false;
    const apply = () => rows.slice(n).forEach(r => r.classList.toggle("hid", !open && !r.classList.contains("favrow")));
    const wrap = document.createElement("div");
    wrap.className = "expandwrap";
    const btn = document.createElement("button");
    btn.className = "tab";
    btn.onclick = () => {
      open = !open;
      apply();
      btn.textContent = open ? `Show Top ${n} ▴` : `Show All ${rows.length} ${noun} ▾`;
      if (!open && host.getBoundingClientRect().top < 0) host.scrollIntoView({ block: "start" });
    };
    btn.textContent = `Show All ${rows.length} ${noun} ▾`;
    apply();
    wrap.appendChild(btn);
    host.after(wrap);
  }

  function tabsHTML(items, onKey) {
    return items.map(t => `<button class="tab bd-mini${t.on ? " on" : ""}" data-${onKey}="${qa(CCViz.esc(t.key))}">${CCViz.esc(t.label)}</button>`).join("");
  }
  function wireTabs(host, attr, fn) {
    host.querySelectorAll(`[data-${attr}]`).forEach(b => b.onclick = () => {
      host.querySelectorAll(`[data-${attr}]`).forEach(x => x.classList.toggle("on", x === b));
      fn(b.dataset[attr.replace(/-(.)/g, (_, c) => c.toUpperCase())]);
    });
  }

  /* ================================================================
     SHAPE "history" — WGI. No published score feed, so the board is the
     championship record (reigning champions, the full honor roll, the
     dynasty count) plus the official schedule, and it says plainly why
     there are no season scores. */
  async function renderHistory(ctx) {
    const { app, data, stale, cfg } = ctx;
    const H = ctx.helpers;
    const esc = H.esc;
    const [champions, index, upcoming] = await Promise.all([
      data("champions.json").catch(() => ({})),
      data("corps_index.json").catch(() => []),
      data("upcoming.json").catch(() => []),
    ]);
    if (stale()) return;
    await H.ensureLogos();
    if (stale()) return;

    const champYears = Object.keys(champions || {}).map(Number).filter(y => y > 0).sort((a, b) => a - b);
    const latestYear = champYears[champYears.length - 1];
    const allClasses = H.sortClasses([...new Set(champYears.flatMap(y => Object.keys(champions[y] || {})))]);
    const totalTitles = champYears.reduce((a, y) => a + Object.keys(champions[y] || {}).length, 0);
    const fmtScore = H.score3;

    app.innerHTML = `
      <h1 class="page">Championship History</h1>
      <div class="notice" style="margin:0 0 14px">
        WGI publishes live scores through its directors-only portal, so Cadence shows what is
        openly published: the championship record and the official event schedule.
        Score coverage is pending permission from WGI.
      </div>
      ${champYears.length ? `<div class="bd-tiles">
        <div class="tile"><div class="label">Championship seasons</div><div class="value">${champYears.length}</div><div class="sub">${champYears[0]}–${latestYear}</div></div>
        <div class="tile"><div class="label">Classes contested</div><div class="value">${allClasses.length}</div><div class="sub">at World Championships</div></div>
        <div class="tile"><div class="label">Titles on record</div><div class="value">${totalTitles}</div><div class="sub">gold medals awarded</div></div>
        <div class="tile"><div class="label">${esc(cap1(cfg.terms.plural))} tracked</div><div class="value">${(index || []).length}</div><div class="sub">with profile pages</div></div>
      </div>` : ""}
      ${latestYear ? `<div class="card">
        <h2>Reigning Champions <span class="sub">${esc(String(latestYear))} World Championships</span></h2>
        <div class="champ-grid">${allClasses.map(cls => {
          const c = champions[latestYear] && champions[latestYear][cls];
          if (!c || !c.corps) return "";
          return `<div class="champ-tile">${H.corpsLogo(c.corps, 34)}<span class="champ-tile-t">
            <span class="champ-tile-cls">${esc(cls)}</span><b>${H.corpsLink(c.corps)}</b>
            ${c.score != null ? `<span class="champ-tile-s">${fmtScore(c.score)}</span>` : ""}</span></div>`;
        }).join("")}</div>
      </div>` : ""}
      <div class="card" style="margin-top:14px">
        <h2>Champions Honor Roll <span class="sub">every World Champion on record, class by class</span></h2>
        <div class="filters" id="bdRollTabs" style="margin:2px 0 8px"></div>
        <div id="bdRollBody"></div>
      </div>
      <div class="card" style="margin-top:14px">
        <h2>Dynasties <span class="sub">most World Championship titles</span></h2>
        <div class="filters" id="bdDynTabs" style="margin:2px 0 8px"></div>
        <div id="bdDynBody"></div>
      </div>
      <div class="card" style="margin-top:14px">
        <h2 id="bdSchedTitle">Official Schedule</h2>
        <div id="bdSched"></div>
      </div>`;

    /* ----- honor roll ----- */
    const rollTabs = document.getElementById("bdRollTabs");
    const rollBody = document.getElementById("bdRollBody");
    let rollAsc = false;
    let rollCls = allClasses[0];
    function drawRoll() {
      if (!rollCls) { rollBody.innerHTML = '<div class="empty">The champions record builds with the next data run.</div>'; return; }
      let rows = titleRows(champions, rollCls);
      if (rollAsc) rows = rows.slice().reverse();
      const counts = new Map(titleCounts(champions, rollCls).map(r => [r.corps, r.titles]));
      rollBody.innerHTML = rows.length ? `<div class="tscroll"><table class="t"><thead><tr>
          <th>Year</th><th>Champion</th><th class="num">Score</th><th class="num m-hide">Title #</th></tr></thead><tbody>
        ${rows.map(r => {
          const nth = rows.filter(x => x.corps === r.corps && x.year <= r.year).length;
          return `<tr${H.FAVS.has(r.corps) ? ' class="favrow"' : ""}>
            <td class="rank" style="width:52px">${r.year}</td>
            <td><span class="corpscell">${H.corpsLogo(r.corps, 24)}<span class="corpscell-body"><span class="corpscell-name">${H.corpsLink(r.corps)}${r.year === latestYear ? ' <span class="classbadge">reigning</span>' : ""}</span></span></span></td>
            <td class="num score">${r.score != null ? fmtScore(r.score) : "—"}</td>
            <td class="num m-hide" style="color:var(--muted)">${nth} of ${counts.get(r.corps) || nth}</td></tr>`;
        }).join("")}
        </tbody></table></div>` : `<div class="empty">No champions on record for ${esc(rollCls)} yet.</div>`;
      collapseRows(rollBody.querySelector("tbody"), 12, "champions", H.FAVS);
    }
    if (allClasses.length) {
      rollTabs.innerHTML = tabsHTML(allClasses.map((c, i) => ({ key: c, label: c, on: !i })), "bd-roll") +
        `<button class="tab bd-mini" id="bdRollOrder" style="margin-left:auto">Oldest first</button>`;
      wireTabs(rollTabs, "bd-roll", k => { rollCls = k; drawRoll(); });
      document.getElementById("bdRollOrder").onclick = e => {
        rollAsc = !rollAsc;
        e.target.textContent = rollAsc ? "Newest first" : "Oldest first";
        drawRoll();
      };
    } else rollTabs.hidden = true;
    drawRoll();

    /* ----- dynasties ----- */
    const dynTabs = document.getElementById("bdDynTabs");
    const dynBody = document.getElementById("bdDynBody");
    function drawDyn(cls) {
      const rows = titleCounts(champions, cls === "*" ? null : cls);
      dynBody.innerHTML = rows.length ? `<div class="tscroll"><table class="t"><thead><tr>
          <th>#</th><th>${esc(cap1(cfg.terms.singular))}</th><th class="num">Titles</th><th class="num m-hide">First</th><th class="num">Latest</th></tr></thead><tbody>
        ${rows.map((r, i) => `<tr${H.FAVS.has(r.corps) ? ' class="favrow"' : ""}>
          <td class="rank">${i + 1}</td>
          <td><span class="corpscell">${H.corpsLogo(r.corps, 24)}<span class="corpscell-body"><span class="corpscell-name">${H.corpsLink(r.corps)}</span></span></span></td>
          <td class="num score">${r.titles}</td>
          <td class="num m-hide">${r.first}</td>
          <td class="num">${r.latest}</td></tr>`).join("")}
        </tbody></table></div>` : '<div class="empty">No titles on record yet.</div>';
      collapseRows(dynBody.querySelector("tbody"), 10, cfg.terms.plural, H.FAVS);
    }
    dynTabs.innerHTML = tabsHTML(
      [{ key: "*", label: "All classes", on: true }, ...allClasses.map(c => ({ key: c, label: c, on: false }))],
      "bd-dyn");
    wireTabs(dynTabs, "bd-dyn", drawDyn);
    drawDyn("*");

    /* ----- official schedule ----- */
    const schedHost = document.getElementById("bdSched");
    const schedTitle = document.getElementById("bdSchedTitle");
    const evs = (upcoming || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const schedRow = ev => `<div class="bd-up"><b>${esc(fmtDY(ev.date) || ev.date_display || "")}</b> — ${esc(ev.name)}${ev.location ? `<span class="bd-upwhere">${esc(ev.location)}</span>` : ""}</div>`;
    if (evs.length) {
      const yr = String(evs[0].date || "").slice(0, 4);
      schedTitle.innerHTML = `Official Schedule <span class="sub">${esc(yr)} season, as published by WGI</span>`;
      const shown = evs.slice(0, 12);
      schedHost.innerHTML = shown.map(schedRow).join("") +
        (evs.length > shown.length ? `<div class="expandwrap"><button class="tab" id="bdSchedMore">Show All ${evs.length} Events ▾</button></div>` : "");
      const more = document.getElementById("bdSchedMore");
      if (more) more.onclick = () => { schedHost.innerHTML = evs.map(schedRow).join(""); };
    } else {
      schedTitle.innerHTML = "Official Schedule";
      schedHost.innerHTML = '<div class="empty">The next season\'s schedule lands here when WGI publishes it.</div>';
    }
  }

  /* ---------- entry point ---------- */
  async function render(ctx) {
    const { app, stale, shape } = ctx;
    app.innerHTML = '<div class="loading">Loading…</div>';
    try {
      if (shape === "history") return await renderHistory(ctx);
      throw new Error(`unknown board shape "${shape}"`);
    } catch (e) {
      if (!stale()) {
        app.innerHTML = `<div class="card"><div class="empty">Couldn't load this view (${ctx.helpers.esc(e && e.message || e)}). Data may be mid-update — try again in a minute.</div></div>`;
      }
    }
  }

  window.CadBoard = {
    render,
    /* pure pieces exposed for an offline test harness */
    _internals: { titleRows, titleCounts },
  };
})();
