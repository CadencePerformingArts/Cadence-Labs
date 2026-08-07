/* Cadence WGI — the WGI Sport of the Arts scoreboard, built in the image of
   the Cadence DCI dashboard (same shell, cards, tables and theming).
   Hash-routed views: #/ scoreboard · #/events · #/event/<id> · #/ensembles ·
   #/ensemble/<id> · #/about.
   Runs on clearly-labeled demo data (data/wgi.json) until a permitted WGI
   source exists. */
(function () {
  "use strict";
  const $app = document.getElementById("app");
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let DB = null;

  /* ---------- state: last activity + class per activity, remembered ---------- */
  function activity() {
    const a = localStorage.getItem("wgi-activity");
    return DB && DB.activities[a] ? a : (DB ? DB.activity_order[0] : "guard");
  }
  function setActivity(a) { localStorage.setItem("wgi-activity", a); }
  function klass(act) {
    const saved = localStorage.getItem("wgi-class-" + act);
    const order = DB.activities[act].class_order;
    return order.includes(saved) ? saved : order[0];
  }
  function setKlass(act, c) { localStorage.setItem("wgi-class-" + act, c); }

  const fmt = v => (v == null ? "—" : (+v).toFixed(3).replace(/0+$/, "").replace(/\.$/, ".0"));
  const fmtDate = iso => {
    const [y, m, d] = (iso || "").split("-").map(Number);
    const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return y ? `${M[m - 1]} ${d}, ${y}` : iso;
  };
  const deltaHtml = d => d == null ? "" :
    `<span class="delta ${d > 0.001 ? "up" : d < -0.001 ? "down" : "flat"}">${d > 0 ? "+" : ""}${fmt(d)}</span>`;

  function actTabs(current, hashFor) {
    const EMOJI = { guard: "🚩", percussion: "🥁", winds: "🎷" };
    return `<div class="acttabs">` + DB.activity_order.map(a =>
      `<a href="${hashFor(a)}" data-act="${a}" class="${a === current ? "on" : ""}"><span class="em">${EMOJI[a]}</span>${esc(DB.activities[a].name)}</a>`
    ).join("") + `</div>`;
  }

  function classTabs(act, current) {
    return `<div class="subtabs">` + DB.activities[act].class_order.map(c =>
      `<a href="#/" data-cls="${esc(c)}" class="${c === current ? "on" : ""}">${esc(c)}</a>`
    ).join("") + `</div>`;
  }

  function ensembleLink(act, id, name) {
    return `<a href="#/ensemble/${act}/${encodeURIComponent(id)}"><b>${esc(name)}</b></a>`;
  }

  /* ------------------------------ scoreboard ------------------------------ */
  function viewScoreboard() {
    const act = activity();
    const cls = klass(act);
    const block = DB.activities[act].classes[cls];
    const rows = (block && block.rows) || [];

    const movers = rows.filter(r => r.delta != null && r.delta > 0)
      .sort((a, b) => b.delta - a.delta);
    let battle = null;
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i - 1].score - rows[i].score;
      if (!battle || gap < battle.gap) battle = { a: rows[i - 1], b: rows[i], gap };
    }

    const table = `
      <table class="t">
        <thead><tr><th class="rank">#</th><th>Ensemble</th><th class="sparkcell"></th><th class="num">Score</th><th>Last scored at</th></tr></thead>
        <tbody>${rows.map(r => `
          <tr class="rowlink" data-href="#/ensemble/${act}/${encodeURIComponent(r.id)}">
            <td class="rank">${r.rank}</td>
            <td>${ensembleLink(act, r.id, r.ensemble)}<div class="lastev">${esc(r.home || "")}</div></td>
            <td class="sparkcell"><span class="sparkbox" data-spark="${r.trend.map(t => t[1]).join(",")}"></span></td>
            <td class="num"><span class="score">${fmt(r.score)}</span><br>${deltaHtml(r.delta)}</td>
            <td><div>${esc(r.event || "")}</div><div class="lastev">${fmtDate(r.date)} · ${r.outings} outing${r.outings === 1 ? "" : "s"}</div></td>
          </tr>`).join("")}
        </tbody>
      </table>`;

    const side = `
      ${movers[0] ? `<div class="card"><h3>📈 Biggest Move <span class="sub">latest outing</span></h3>
        <div><b>${esc(movers[0].ensemble)}</b> ${deltaHtml(movers[0].delta)} to <span class="score">${fmt(movers[0].score)}</span></div>
        <div class="lastev">${esc(movers[0].event)}</div></div>` : ""}
      ${battle ? `<div class="card"><h3>⚔️ Closest Battle <span class="sub">${esc(cls)}</span></h3>
        <div><b>${esc(battle.a.ensemble)}</b> vs <b>${esc(battle.b.ensemble)}</b></div>
        <div class="lastev">${fmt(battle.gap)} apart at #${battle.a.rank}–${battle.b.rank}</div></div>` : ""}
      <div class="card"><h3>About this class</h3>
        <div class="lastev">WGI classes are scored on separate sheets — ${esc(cls)} standings never mix with other classes. Scores shown are each ensemble's most recent.</div></div>`;

    $app.innerHTML = `
      ${actTabs(act, () => "#/")}
      ${classTabs(act, cls)}
      <div class="grid cols-2">
        <div class="card">
          <h2>${esc(DB.activities[act].name)} — ${esc(cls)} <span class="sub">season ${DB.season} · demo</span></h2>
          ${rows.length ? table : `<div class="loading">No results in this class yet.</div>`}
        </div>
        <div>${side}</div>
      </div>`;

    $app.querySelectorAll("[data-act]").forEach(a => a.addEventListener("click", e => {
      e.preventDefault(); setActivity(a.dataset.act); render();
    }));
    $app.querySelectorAll("[data-cls]").forEach(a => a.addEventListener("click", e => {
      e.preventDefault(); setKlass(act, a.dataset.cls); render();
    }));
    wireRows();
    drawSparks();
  }

  function wireRows() {
    $app.querySelectorAll("tr.rowlink").forEach(tr =>
      tr.addEventListener("click", e => {
        if (e.target.closest("a")) return;
        location.hash = tr.dataset.href;
      }));
  }

  function drawSparks() {
    $app.querySelectorAll(".sparkbox").forEach(el => {
      const vals = el.dataset.spark.split(",").map(Number).filter(v => !isNaN(v));
      if (vals.length > 1 && window.CCViz) CCViz.sparkline(el, vals, "#f0b429");
    });
  }

  /* -------------------------------- events -------------------------------- */
  function viewEvents() {
    const act = activity();
    const evs = DB.events.filter(e => e.activity === act).slice().reverse();
    const up = (DB.upcoming || []).filter(u => u.activities.includes(act));

    $app.innerHTML = `
      ${actTabs(act, () => "#/events")}
      ${up.length ? `<div class="evsectlabel">Upcoming</div>` + up.map(u => `
        <div class="card"><h3>${esc(u.name)} <span class="sub">${esc(u.date_display || u.date)} · ${esc(u.city)}</span></h3>
        <div class="lastev">Lineups announced closer to the event.</div></div>`).join("") : ""}
      <div class="evsectlabel">Results</div>
      ${evs.map(ev => {
        const last = ev.sessions[ev.sessions.length - 1];
        const podium = [];
        for (const c of DB.activities[act].class_order) {
          const rows = last.classes[c];
          if (rows && rows[0]) podium.push(`<span class="classpill">${esc(c)}</span> <b>${esc(rows[0].ensemble)}</b> <span class="score">${fmt(rows[0].score)}</span>`);
        }
        return `
        <div class="card">
          <h3><a href="#/event/${esc(ev.id)}">${esc(ev.name)}</a>
            ${ev.worlds ? `<span class="pill">Championships</span>` : ""}
            <span class="sub">${fmtDate(ev.date)} · ${esc(ev.city)} · ${ev.sessions.map(s => s.name).join(" + ")}</span></h3>
          <div class="lastev" style="display:flex;gap:14px;flex-wrap:wrap">${podium.join(" ")}</div>
        </div>`;
      }).join("")}`;

    $app.querySelectorAll("[data-act]").forEach(a => a.addEventListener("click", e => {
      e.preventDefault(); setActivity(a.dataset.act); render();
    }));
  }

  function viewEvent(id) {
    const ev = DB.events.find(e => e.id === id);
    if (!ev) { $app.innerHTML = `<div class="loading">Event not found.</div>`; return; }
    const act = ev.activity;
    const sessIdx = Math.min(+(sessionStorage.getItem("wgi-sess-" + id) || ev.sessions.length - 1), ev.sessions.length - 1);
    const sess = ev.sessions[sessIdx];

    const classBlocks = DB.activities[act].class_order.map(c => {
      const rows = sess.classes[c];
      if (!rows || !rows.length) return "";
      return `
        <div class="secdiv">${esc(c)}</div>
        <table class="t"><tbody>${rows.map(r => `
          <tr class="rowlink" data-href="#/ensemble/${act}/${encodeURIComponent(slug(r.ensemble))}">
            <td class="rank">${r.place}</td>
            <td><b>${esc(r.ensemble)}</b>${r.award ? ` <span class="awardpill">🏆 ${esc(r.award)}</span>` : ""}<div class="lastev">${esc(r.home || "")}</div></td>
            <td class="num"><span class="score">${fmt(r.score)}</span></td>
          </tr>`).join("")}</tbody></table>`;
    }).join("");

    $app.innerHTML = `
      <div class="card">
        <h2>${esc(ev.name)} <span class="sub">${fmtDate(ev.date)} · ${esc(ev.city)} · ${esc(DB.activities[act].name)}</span></h2>
        ${ev.sessions.length > 1 ? `<div class="subtabs">${ev.sessions.map((s, i) =>
          `<a href="#/event/${esc(id)}" data-sess="${i}" class="${i === sessIdx ? "on" : ""}">${esc(s.name)}</a>`).join("")}</div>` : ""}
        ${classBlocks}
      </div>
      <p><a href="#/events">← All ${esc(DB.activities[act].name)} events</a></p>`;

    $app.querySelectorAll("[data-sess]").forEach(a => a.addEventListener("click", e => {
      e.preventDefault(); sessionStorage.setItem("wgi-sess-" + id, a.dataset.sess); render();
    }));
    wireRows();
  }

  /* ------------------------------ ensembles ------------------------------ */
  function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  }

  function viewEnsembles() {
    const act = activity();
    const blocks = DB.activities[act].class_order.map(c => {
      const rows = (DB.activities[act].classes[c] || {}).rows || [];
      if (!rows.length) return "";
      return `
        <div class="secdiv">${esc(c)}</div>
        <table class="t"><tbody>${rows.map(r => `
          <tr class="rowlink" data-href="#/ensemble/${act}/${encodeURIComponent(r.id)}">
            <td>${ensembleLink(act, r.id, r.ensemble)}<div class="lastev">${esc(r.home || "")}</div></td>
            <td class="num"><span class="score">${fmt(r.score)}</span><div class="lastev">#${r.rank} in class</div></td>
          </tr>`).join("")}</tbody></table>`;
    }).join("");
    $app.innerHTML = `${actTabs(act, () => "#/ensembles")}<div class="card"><h2>${esc(DB.activities[act].name)} ensembles <span class="sub">by class</span></h2>${blocks}</div>`;
    $app.querySelectorAll("[data-act]").forEach(a => a.addEventListener("click", e => {
      e.preventDefault(); setActivity(a.dataset.act); render();
    }));
    wireRows();
  }

  function findEnsemble(act, id) {
    const A = DB.activities[act];
    if (!A) return null;
    for (const c of A.class_order) {
      const row = (A.classes[c].rows || []).find(r => r.id === id);
      if (row) return { row, cls: c };
    }
    return null;
  }

  function viewEnsemble(act, id) {
    const hit = findEnsemble(act, id);
    if (!hit) { $app.innerHTML = `<div class="loading">Ensemble not found.</div>`; return; }
    const { row, cls } = hit;

    const results = row.trend.slice().reverse();
    $app.innerHTML = `
      <div class="card">
        <h2>${esc(row.ensemble)} <span class="sub">${esc(DB.activities[act].name)} · ${esc(cls)} · ${esc(row.home || "")}</span></h2>
        <div style="display:flex;gap:26px;flex-wrap:wrap;margin:6px 0 4px">
          <div><div class="kicker">CLASS RANK</div><div class="score" style="font-size:26px">#${row.rank}</div></div>
          <div><div class="kicker">LATEST</div><div class="score" style="font-size:26px">${fmt(row.score)}</div></div>
          <div><div class="kicker">OUTINGS</div><div class="score" style="font-size:26px">${row.outings}</div></div>
        </div>
      </div>
      <div class="card"><h3>Season progression <span class="sub">${DB.season} demo season</span></h3><div id="wgiChart"></div></div>
      <div class="card"><h3>Results</h3>
        <table class="t"><tbody>${results.map(t => `
          <tr><td><div>${esc(t[2])}</div><div class="lastev">${fmtDate(t[0])}</div></td>
          <td class="num"><span class="score">${fmt(t[1])}</span></td></tr>`).join("")}</tbody></table>
      </div>
      <p><a href="#/">← ${esc(cls)} scoreboard</a></p>`;

    if (window.CCViz) {
      CCViz.lineChart(document.getElementById("wgiChart"), {
        series: [{ name: row.ensemble, color: "#7c3aed", points: row.trend.map((t, i) => ({ x: i, y: t[1] })) }],
        xLabels: row.trend.map(t => fmtDate(t[0]).replace(/, \d+$/, "")),
        height: 260,
      });
    }
  }

  /* -------------------------------- about -------------------------------- */
  function viewAbout() {
    $app.innerHTML = `
      <div class="card"><h2>About Cadence WGI</h2>
        <p>This is the WGI app of the Cadence family, built to feel exactly like the Cadence DCI
        dashboard: same scoreboard, events and ensemble views — with WGI's structure on top.
        The activity selector (Color Guard · Percussion · Winds) switches between WGI's three
        sports, and every class is scored on its own sheet, so classes never share a table.</p>
        <p><b>All data on this site is a demonstration season.</b> Ensemble names are real,
        well-known programs; every score is invented. WGI Sport of the Arts publishes results
        through its own channels, and Cadence will not ingest them without a permitted source —
        when one exists, this app lights up with live data exactly like the DCI dashboard.</p>
        <p>Cadence is an unofficial fan project, not affiliated with WGI Sport of the Arts.</p>
        <p><a href="../modes.html">← The Cadence family</a></p>
      </div>`;
  }

  /* -------------------------------- router -------------------------------- */
  function setNav(route) {
    document.querySelectorAll("#nav a").forEach(a =>
      a.classList.toggle("active", a.dataset.route === route));
  }

  function render() {
    if (!DB) return;
    const h = location.hash || "#/";
    const parts = h.replace(/^#\//, "").split("/");
    scrollTo(0, 0);
    if (h === "#/" || h === "") { setNav("rankings"); viewScoreboard(); }
    else if (parts[0] === "events") { setNav("events"); viewEvents(); }
    else if (parts[0] === "event") { setNav("events"); viewEvent(decodeURIComponent(parts.slice(1).join("/"))); }
    else if (parts[0] === "ensembles") { setNav("ensembles"); viewEnsembles(); }
    else if (parts[0] === "ensemble") { setNav("ensembles"); viewEnsemble(parts[1], decodeURIComponent(parts[2] || "")); }
    else if (parts[0] === "about") { setNav(""); viewAbout(); }
    else { setNav("rankings"); viewScoreboard(); }
  }

  addEventListener("hashchange", render);

  fetch("data/wgi.json")
    .then(r => r.json())
    .then(d => {
      DB = d;
      const u = document.getElementById("updated");
      if (u) u.textContent = "demo data";
      render();
    })
    .catch(() => { $app.innerHTML = `<div class="loading">Couldn’t load the demo dataset.</div>`; });
})();
