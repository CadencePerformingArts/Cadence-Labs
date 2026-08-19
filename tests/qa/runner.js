/* Cadence browser QA — the whole app, driven for real.
   Serves docs/ on a local port, launches Chromium, and walks every route and
   critical flow at phone + desktop widths, both themes, and all text sizes.
   Exit code 0 = clean. Any finding prints with its section and fails the run.

   Local:  cd tests/qa && npm ci && npm test
   Alt:    PW_MODULE=$(npm root -g)/playwright PW_EXECUTABLE=/path/to/chrome npm test
   CI:     .github/workflows/qa.yml runs exactly `npm ci && npm test`. */
"use strict";
const path = require("node:path");
const { start } = require("./serve");

let pw;
try { pw = require("playwright"); }
catch (e) {
  try { pw = require(process.env.PW_MODULE || "/dev/null"); }
  catch (e2) {
    console.error("playwright not found — run `npm ci` here, or set PW_MODULE to a playwright install");
    process.exit(2);
  }
}

const EXECUTABLE = process.env.PW_EXECUTABLE || undefined;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const ROUTES = ["#/", "#/?y=2019", "#/events", "#/corps", "#/corps/bluecoats", "#/stats", "#/captions",
  "#/compare", "#/champions", "#/records", "#/database", "#/predictions", "#/settings",
  "#/suggestions", "#/about", "#/ask"];

const findings = [];
let currentSection = "";
const bad = msg => findings.push(`[${currentSection}] ${msg}`);

// standard localStorage seeds: an established visitor with no pending popups
const SEEDS = `
  localStorage.setItem("cad-onboard", "1");
  localStorage.setItem("cad-rc-autoseen", "1");
  localStorage.setItem("cad-install-snooze", String(Date.now() + 864e5));
  sessionStorage.setItem("cad-rc-session", "1");`;

async function ctxPage(browser, base, { viewport = PHONE, seeds = SEEDS, theme, fontSize, favs, sw = false } = {}) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: sw ? "allow" : "block" });
  await ctx.addInitScript(`(() => { try {
    ${seeds}
    ${theme ? `localStorage.setItem("cad-theme", ${JSON.stringify(theme)});` : ""}
    ${fontSize ? `localStorage.setItem("cad-fontsize", ${JSON.stringify(fontSize)});` : ""}
    ${favs ? `localStorage.setItem("cad-favs", ${JSON.stringify(JSON.stringify(favs))});` : ""}
  } catch (e) {} })()`);
  const page = await ctx.newPage();
  page._errs = [];
  page.on("pageerror", e => page._errs.push("pageerror: " + e.message.slice(0, 140)));
  page.on("console", m => {
    if (m.type() === "error" && !/favicon|manifest|sw\.js|Failed to load resource/.test(m.text()))
      page._errs.push("console: " + m.text().slice(0, 140));
  });
  page.goHash = async h => {
    await page.goto(base + "/index.html" + h, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1300);
  };
  page.overflowPx = () => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  return { ctx, page };
}

// ---------------------------------------------------------------------------
const sections = [];
const section = (name, fn) => sections.push([name, fn]);

section("routes render clean (phone + desktop)", async (browser, base) => {
  for (const viewport of [PHONE, DESKTOP]) {
    const { ctx, page } = await ctxPage(browser, base, { viewport });
    for (const h of ROUTES) {
      await page.goHash(h);
      const label = `${h} @${viewport.width}`;
      const over = await page.overflowPx();
      if (over > 1) bad(`${label}: horizontal overflow ${over}px`);
      const empty = await page.evaluate(() => {
        const m = document.getElementById("app");
        return !m || m.innerText.trim().length < 10;
      });
      if (empty) bad(`${label}: page rendered (nearly) empty`);
      const broken = await page.evaluate(() => [...document.images]
        .filter(i => i.offsetParent !== null && i.complete && i.naturalWidth === 0 && !i.hidden).length);
      if (broken) bad(`${label}: ${broken} broken image(s)`);
    }
    if (page._errs.length) bad(`@${viewport.width}: ${[...new Set(page._errs)].slice(0, 4).join(" | ")}`);
    await ctx.close();
  }
});

section("legacy routes keep redirecting", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base);
  const cases = [
    ["#/data", /#\/captions/], ["#/stats", /#\/captions/],
    ["#/seasons", /#\/(seasons|champions)/], ["#/today", /#\/(today|$)/],
    ["#/season/2025", /#\/events\?y=2025/], ["#/season/dci/2019", /#\/events\?y=2019/],
  ];
  for (const [from, want] of cases) {
    await page.goHash(from);
    const now = await page.evaluate(() => location.hash);
    if (!want.test(now)) bad(`${from} landed on ${now}`);
    const empty = await page.evaluate(() => (document.getElementById("app") || {}).innerText?.trim().length < 10);
    if (empty) bad(`${from}: destination rendered empty`);
  }
  await ctx.close();
});

section("themes, text sizes, corps colors", async (browser, base) => {
  for (const theme of ["light", "dark"]) {
    for (const fontSize of ["1", "1.1", "1.2"]) {
      const { ctx, page } = await ctxPage(browser, base, { theme, fontSize });
      for (const h of ["#/", "#/events", "#/settings"]) {
        await page.goHash(h);
        const over = await page.overflowPx();
        if (over > 2) bad(`${theme}/fs=${fontSize} ${h}: overflow ${over}px`);
      }
      if (page._errs.length) bad(`${theme}/fs=${fontSize}: ${page._errs[0]}`);
      await ctx.close();
    }
  }
  // corps colors persist and repaint
  const { ctx, page } = await ctxPage(browser, base);
  await page.goHash("#/settings");
  // skip the first chip — that's the "default look" reset, which clears the theme
  const chip = (await page.$$("[data-corps-set]"))[1];
  if (!chip) bad("no corps-theme chip in Settings");
  else {
    await chip.click();
    await page.waitForTimeout(600);
    const applied = await page.evaluate(() => document.documentElement.dataset.corps || "");
    if (!applied) bad("corps theme did not apply data-corps");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const kept = await page.evaluate(() => document.documentElement.dataset.corps || "");
    if (kept !== applied) bad(`corps theme lost on reload (${applied} → ${kept})`);
  }
  await ctx.close();
});

section("first-run onboarding → favorites → Following strip", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base, { seeds: "" }); // true first visit
  await page.goHash("#/");
  await page.waitForTimeout(1600);
  const sheet = await page.$(".ob-sheet");
  if (!sheet) { bad("onboarding sheet did not appear on a first visit"); await ctx.close(); return; }
  await page.fill(".ob-search", "blue");
  await page.waitForTimeout(250);
  const visible = await page.$$eval(".ob-chip:not([hidden])", els => els.map(e => e.dataset.corps));
  if (!visible.length || !visible.every(n => /blue/i.test(n))) bad("onboarding search filter failed");
  await page.fill(".ob-search", "");
  const chips = await page.$$(".ob-chip");
  await chips[0].click();
  await page.click("#obDone");
  await page.waitForTimeout(900);
  if (await page.$("#obAlerts")) await page.click("#obLater");
  await page.waitForTimeout(900);
  if (await page.$(".ob-ov")) bad("sheet still open after Done");
  if (!(await page.$$(".fol-card")).length) bad("Following strip missing after picking a favorite");
  if (await page.evaluate(() => localStorage.getItem("cad-onboard")) !== "1") bad("completion key not set");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);
  if (await page.$(".ob-ov")) bad("sheet reappeared after completion");
  if (page._errs.length) bad(page._errs[0]);
  await ctx.close();
});

section("season picker: browse the archive from the Scoreboard heading", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base, { favs: ["Bluecoats"] });
  await page.goHash("#/");
  const heading = await page.evaluate(() => document.querySelector("h1.page").innerText.replace(/\s+/g, " ").trim());
  if (!/^\d{4} Scoreboard$/.test(heading)) bad(`heading is not "<year> Scoreboard": "${heading}"`);
  const current = (await page.textContent(".yearpick")).trim();

  // opens, lists every season newest-first, marks the one being viewed
  await page.click(".yearpick");
  await page.waitForTimeout(400);
  const years = await page.$$eval(".yearopt", els => els.map(e => +e.textContent.trim()));
  if (years.length < 20) bad(`picker lists only ${years.length} seasons`);
  if (String(years[0]) !== current) bad("picker is not sorted newest-first");
  if (years.some((y, i) => i && y >= years[i - 1])) bad("picker years are not strictly descending");
  const marked = await page.$$eval(".yearopt.on", els => els.map(e => e.textContent.trim()));
  if (marked.length !== 1 || marked[0] !== current) bad(`selected season marker: ${JSON.stringify(marked)}`);
  if (await page.getAttribute(".yearpick", "aria-expanded") !== "true") bad("aria-expanded stays false when open");

  // Escape closes it and returns focus to the trigger
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  if (await page.$(".yearpanel:not([hidden])")) bad("Escape did not close the season panel");
  if (await page.evaluate(() => document.activeElement.className) !== "yearpick")
    bad("focus not returned to the year button after Escape");

  // pick an older season: URL, heading, and a real board for it
  const older = years.find(y => y <= years[0] - 5) || years[years.length - 1];
  await page.click(".yearpick");
  await page.waitForTimeout(300);
  await page.click(`.yearopt[data-y="${older}"]`);
  await page.waitForTimeout(1800);
  if (await page.evaluate(() => location.hash) !== `#/?y=${older}`) bad("URL did not carry the picked season");
  if ((await page.textContent(".yearpick")).trim() !== String(older)) bad("heading did not switch season");
  if (!(await page.$$("#standings tbody tr")).length) bad(`${older}: no standings rows`);
  if (!await page.$("#trendChart svg")) bad(`${older}: no progression chart`);
  if (!/last score of the /.test(await page.textContent("#standTitle"))) bad(`${older}: not framed as a finished season`);
  // a settled season carries no live/now modules
  if (await page.$("#followMount")) bad("past season still renders the Following strip");
  if (await page.$(".offszn")) bad("past season still renders This Day in History");
  if (await page.$(".pill.live")) bad("past season shows a LIVE badge");
  const over = await page.overflowPx();
  if (over > 1) bad(`${older} board overflows ${over}px`);

  // the class filter must actually switch the board ON an archived season —
  // its choice lives in memory, not in the device-wide saved preference
  const savedBefore = await page.evaluate(() => localStorage.getItem("dt-classes"));
  const titleBefore = await page.textContent("#standTitle");
  const rowsBefore = (await page.$$("#standings tbody tr")).length;
  await page.click("#clsSel .msel-btn");
  await page.waitForTimeout(400);
  const clsLabels = await page.$$eval("#clsSel .msel-opt", els => els.map(e => e.textContent.replace(/\s+/g, " ").trim()));
  const otherIdx = clsLabels.findIndex(l => !/^World Class/.test(l));
  if (otherIdx < 0) bad(`${older}: only one class to choose from, cannot verify the filter`);
  else {
    await (await page.$$("#clsSel .msel-opt"))[otherIdx].click();
    await page.waitForTimeout(1700);
    const titleAfter = await page.textContent("#standTitle");
    const rowsAfter = (await page.$$("#standings tbody tr")).length;
    if (titleAfter === titleBefore && rowsAfter === rowsBefore)
      bad(`${older}: picking "${clsLabels[otherIdx]}" changed nothing — the class filter is inert on archived seasons`);
    if (await page.evaluate(() => localStorage.getItem("dt-classes")) !== savedBefore)
      bad("an archived season's class choice overwrote the saved current-season preference");
  }

  // 2007's archive holds one indoor mini-corps date 91 days before the tour;
  // the season must still fill the chart rather than being squashed into a
  // corner, and the axis labels must keep telling the truth
  await page.goHash("#/?y=2007");
  await page.waitForTimeout(1500);
  const chart = await page.evaluate(() => {
    const svg = document.querySelector("#trendChart svg");
    if (!svg) return null;
    const xs = [...svg.querySelectorAll('path[d^="M"]')].flatMap(p =>
      (p.getAttribute("d").match(/[ML] ?([\d.]+)/g) || []).map(s => parseFloat(s.replace(/[ML] ?/, ""))));
    const dots = [...svg.querySelectorAll("circle")].map(c => +c.getAttribute("cx")).filter(n => !isNaN(n));
    const all = [...xs, ...dots];
    return all.length && xs.length
      ? { start: (Math.min(...xs) - Math.min(...all)) / (Math.max(...all) - Math.min(...all)) }
      : null;
  });
  if (!chart) bad("2007: no progression chart rendered");
  else if (chart.start > 0.35)
    bad(`2007: an off-tour outlier squashes the season — lines start ${(chart.start * 100).toFixed(0)}% into the plot`);

  // back returns to the current season with its live modules
  await page.goHash("#/");
  await page.waitForTimeout(1200);
  if ((await page.textContent(".yearpick")).trim() !== current) bad("could not get back to the current season");

  // unknown seasons fall back instead of erroring
  for (const badHash of ["#/?y=1899", "#/?y=abc"]) {
    await page.goHash(badHash);
    if ((await page.textContent(".yearpick")).trim() !== current) bad(`${badHash} did not fall back to the current season`);
  }
  if (page._errs.length) bad(page._errs[0]);
  await ctx.close();
});

section("favorites drive the app (strip, standings, settings)", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base, { favs: ["Bluecoats"] });
  await page.goHash("#/");
  const card = await page.$(".fol-card");
  if (!card) bad("no Following card for a stored favorite");
  else if (!/Bluecoats/.test(await card.textContent())) bad("Following card missing the corps");
  const favrow = await page.$("tr.favrow");
  if (!favrow) bad("standings row not highlighted for favorite");
  await page.goHash("#/settings");
  if (!/Bluecoats/.test(await page.textContent("#favSummary"))) bad("Settings favorites summary missing the corps");
  if (page._errs.length) bad(page._errs[0]);
  await ctx.close();
});

section("shows: expansion, filters panel, event page focus", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base);
  await page.goHash("#/events");
  const head = await page.$(".evrow .evhead");
  if (!head) bad("no show rows at all");
  else {
    await head.click();
    await page.waitForTimeout(600);
    if (!await page.$(".evrow .evres, .evrow table")) bad("expanding a show revealed no results/schedule");
  }
  const ft = await page.$("#fToggle");
  if (!ft) bad("no Filters toggle");
  else {
    const panel = await page.$(".fpanel");
    const before = panel && await panel.isVisible();
    await ft.click(); await page.waitForTimeout(300);
    const after = panel && await panel.isVisible();
    if (before === after) bad("Filters toggle did not change panel visibility");
  }

  // the year is the same picker as the Scoreboard — pick a season, the URL and
  // heading follow, and a real board for it renders
  const yp = await page.$("h1.page .yearpick");
  if (!yp) bad("shows: no year picker in the heading");
  else {
    const yrs = await (async () => { await yp.click(); await page.waitForTimeout(300);
      return page.$$eval(".yearopt", els => els.map(e => +e.textContent.trim())); })();
    if (yrs.length < 20) bad(`shows: year picker lists only ${yrs.length} seasons`);
    const older = yrs.find(y => y <= yrs[0] - 5) || yrs[yrs.length - 1];
    await page.click(`.yearopt[data-y="${older}"]`);
    await page.waitForTimeout(1500);
    if (await page.evaluate(() => location.hash) !== `#/events?y=${older}`) bad("shows: picking a year did not update the URL");
    if ((await page.textContent("h1.page .yearpick")).trim() !== String(older)) bad("shows: heading did not switch season");
    if (!await page.$(".evrow, .evsection, .empty")) bad(`shows: ${older} rendered no season body`);
    await page.goHash("#/events"); await page.waitForTimeout(1000);
  }

  // "Latest from DCI": the always-open news card — a photo rail of
  // headlines, the camps list, and an All news link that stays in the app
  const rail = await page.$("#newsMount .newsrail");
  if (rail) {
    if (!await page.$("#newsMount .newsart")) bad("news: rail rendered no headline cards");
    const hadCamps = !!await page.$("#newsMount .newscamps");
    const allNews = await page.$('#newsMount a[href="#/news"]');
    if (!allNews) bad("news: All news link is missing or leaves the app");
    else {
      await allNews.click(); await page.waitForTimeout(900);
      if (await page.evaluate(() => location.hash) !== "#/news") bad("news: All news did not open #/news");
      if (!await page.$(".newsgrid .newsart")) bad("#/news: no headline grid");
      if (hadCamps && !await page.$(".newsanns .newscard")) bad("#/news: no corps announcements");
      await page.goHash("#/events"); await page.waitForTimeout(900);
    }
  }

  // deep-linked corps focus on an event page
  await page.goHash("#/go?y=2026&d=2026-08-08&e=" + encodeURIComponent("DCI World Championship Finals") + "&c=" + encodeURIComponent("Phantom Regiment"));
  await page.waitForTimeout(1600);
  const row = await page.$("tr[data-focus]");
  if (!row) bad("#/go with corps did not mark a focus row");
  else if (!await row.isVisible()) bad("focus row is hidden (collapse not expanded)");
  if (page._errs.length) bad(page._errs[0]);
  await ctx.close();
});

section("stats hub: captions sheet, compare, database, records", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base);
  await page.goHash("#/captions");
  await page.waitForTimeout(1200);
  if (!await page.$(".capcta")) bad("captions: no Caption Winners CTA");
  // the sub-nav is an underline strip, not pills: the active view carries a
  // ~2px bottom line and none of the old rounded-pill chrome
  const subtab = await page.evaluate(() => {
    const on = document.querySelector(".subtabs a.on");
    if (!on) return null;
    const s = getComputedStyle(on);
    return { bb: parseFloat(s.borderBottomWidth), radius: parseFloat(s.borderTopLeftRadius) };
  });
  if (!subtab) bad("stats: no active sub-tab");
  else if (subtab.bb < 1.5) bad(`stats: active sub-tab has no underline (border-bottom ${subtab.bb}px)`);
  else if (subtab.radius > 8) bad(`stats: sub-tab still renders as a pill (radius ${subtab.radius}px)`);
  const sortHeader = await page.$(".capsort th[data-sort], .rt th[data-c]");
  if (sortHeader) { await sortHeader.click(); await page.waitForTimeout(300); }
  await page.goHash("#/compare");
  const msel = await page.$("#corpsSel .msel-btn");
  if (!msel) bad("compare: no corps picker");
  else {
    await msel.click(); await page.waitForTimeout(400);
    const opts = await page.$$("#corpsSel .msel-opt");
    if (opts.length < 2) bad("compare: picker has <2 options");
    else {
      await opts[0].click(); await opts[1].click();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(1600);
      if (!await page.$("#cmpChart svg")) bad("compare: no chart after picking two corps");
    }
  }
  await page.goHash("#/database");
  await page.waitForTimeout(1400);
  if ((await page.$$("table tbody tr")).length < 8) bad("database: too few rows");
  // the sub-nav scrolls on a phone; the active "Database" tab (rightmost) must
  // still sit within the visible strip, not be clipped off the right edge
  const tabVis = await page.evaluate(() => {
    const strip = document.querySelector(".subtabs");
    const on = strip && strip.querySelector("a.on");
    if (!strip || !on) return null;
    const sr = strip.getBoundingClientRect(), ar = on.getBoundingClientRect();
    return ar.left >= sr.left - 1 && ar.right <= sr.right + 1;
  });
  if (tabVis === false) bad("database: active sub-tab is scrolled out of view on a phone");
  const q = await page.$("#fq");
  if (q) {
    await q.fill("Bluecoats");
    await page.waitForTimeout(800);
    const first = await page.$("table tbody tr");
    if (!first || !/Bluecoats/i.test(await first.textContent())) bad("database: corps search failed");
  } else bad("database: no search box");
  await page.goHash("#/records");
  if ((await page.$$(".card")).length < 3) bad("records: too few cards");
  if (page._errs.length) bad(page._errs[0]);
  await ctx.close();
});

section("share card opens with branding footer", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base);
  await page.goHash("#/corps/bluecoats");
  await page.waitForTimeout(1400);
  const btn = await page.$("#corpCard");
  if (!btn) { bad("no share-card button on corps page"); await ctx.close(); return; }
  await btn.click();
  await page.waitForTimeout(2200);
  const hasCanvasImg = await page.evaluate(() =>
    !!document.querySelector("canvas, img[src^='blob:'], img[src^='data:image']"));
  if (!hasCanvasImg) bad("share overlay showed no rendered card");
  if (page._errs.length) bad(page._errs[0]);
  await ctx.close();
});

section("failure states: data 404s degrade with human messages", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base);
  await page.route("**/data/rankings.json*", r => r.fulfill({ status: 404, body: "x" }));
  await page.goHash("#/");
  await page.waitForTimeout(1000);
  const txt = (await page.textContent("#app")).replace(/\s+/g, " ");
  if (!/Couldn't load|Data may be|try again/i.test(txt)) bad("rankings 404: no human error message: " + txt.slice(0, 80));
  if (/undefined|NaN|\[object/.test(txt)) bad("rankings 404: junk in error state");
  await ctx.close();
});

section("stale-data indicator", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base);
  const old = new Date(Date.now() - 3 * 3600e3);
  const stamp = old.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  await page.route("**/data/meta.json*", async r => {
    const body = JSON.parse(require("node:fs").readFileSync(path.join(__dirname, "../../docs/data/meta.json"), "utf8"));
    body.updated = stamp;
    await r.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goHash("#/");
  const cls = await page.evaluate(() => document.getElementById("updated").className);
  if (!/stale/.test(cls)) bad("3h-old data did not trip the stale flag");
  await ctx.close();
  // fresh data must NOT trip it
  const { ctx: c2, page: p2 } = await ctxPage(browser, base);
  const fresh = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  await p2.route("**/data/meta.json*", async r => {
    const body = JSON.parse(require("node:fs").readFileSync(path.join(__dirname, "../../docs/data/meta.json"), "utf8"));
    body.updated = fresh;
    await r.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await p2.goHash("#/");
  if (/stale/.test(await p2.evaluate(() => document.getElementById("updated").className)))
    bad("fresh data wrongly flagged stale");
  await c2.close();
});

section("ask stays honestly unavailable", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base);
  await page.goHash("#/ask");
  const txt = await page.textContent("#app");
  if (!/switched off|unavailable/i.test(txt)) bad("#/ask does not state it is unavailable");
  if (await page.$(".askform")) bad("#/ask still renders a live question form while disabled");
  await ctx.close();
});

section("accessibility: names, tap targets, contrast", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base);
  for (const h of ["#/", "#/events", "#/captions", "#/settings", "#/about"]) {
    await page.goHash(h);
    const unnamed = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("button, a[href]").forEach(el => {
        if (el.offsetParent === null && !el.closest("header,footer")) return;
        const name = (el.getAttribute("aria-label") || el.title || el.textContent || "").trim();
        if (!name) out.push(el.tagName + "." + (el.className || "?"));
      });
      return [...new Set(out)].slice(0, 5);
    });
    if (unnamed.length) bad(`${h}: unnamed controls: ${unnamed.join(", ")}`);
    const small = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("button").forEach(el => {
        if (el.offsetParent === null) return;
        const r = el.getBoundingClientRect();
        const after = getComputedStyle(el, "::after");
        const extended = after.content !== "none" && after.position === "absolute";
        if (!extended && (r.width < 30 || r.height < 30))
          out.push((el.className || el.textContent.trim()).slice(0, 24) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
      });
      return [...new Set(out)].slice(0, 5);
    });
    if (small.length) bad(`${h}: small tap targets: ${small.join(" | ")}`);
  }
  // contrast spot check in both themes
  for (const theme of ["light", "dark"]) {
    const { ctx: c, page: p } = await ctxPage(browser, base, { theme });
    await p.goHash("#/");
    const fails = await p.evaluate(() => {
      const lum = rgb => { const [r, g, b] = rgb.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
      const parse = s => { const m = s.match(/\d+(\.\d+)?/g); return m ? m.slice(0, 3).map(Number) : null; };
      const bgOf = el => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor, p = parse(c); if (p && !/rgba?\(0, 0, 0, 0\)/.test(c)) return p; } return [255, 255, 255]; };
      const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05); };
      const out = [];
      for (const sel of [".kicker", ".sub", "td.num", ".card h2", "p.lede", ".foot div", ".fol-sub", ".otd-t", ".abouttxt", ".yearopt", ".yearopt.on"]) {
        const el = document.querySelector(sel);
        if (!el || !el.textContent.trim()) continue;
        const cs = getComputedStyle(el), fg = parse(cs.color);
        if (!fg) continue;
        const r = ratio(fg, bgOf(el));
        const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 600;
        const min = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
        if (r < min) out.push(`${sel} ${r.toFixed(2)} < ${min}`);
      }
      return out;
    });
    if (fails.length) bad(`${theme}: contrast: ${fails.join(", ")}`);
    await c.close();
  }
  await ctx.close();
});

section("offline: shell loads from the service worker", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base, { sw: true });
  await page.goto(base + "/index.html#/", { waitUntil: "load" });
  await page.waitForTimeout(2500); // let the SW install and cache the shell
  const swReady = await page.evaluate(() =>
    navigator.serviceWorker.getRegistration().then(r => !!(r && (r.active || r.waiting || r.installing))));
  if (!swReady) { bad("service worker never registered on localhost"); await ctx.close(); return; }
  await page.waitForTimeout(2000);
  await ctx.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => bad("offline reload failed outright"));
  await page.waitForTimeout(1800);
  const alive = await page.evaluate(() => !!document.querySelector("#nav") && document.body.innerText.length > 50);
  if (!alive) bad("offline shell did not render");
  await ctx.setOffline(false);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const back = await page.evaluate(() => document.body.innerText.includes("Scoreboard"));
  if (!back) bad("did not recover when back online");
  await ctx.close();
});

section("2027 rollover: a new season appears with zero code changes", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base);
  const fs = require("node:fs");
  const dataDir = path.join(__dirname, "../../docs/data");
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, "meta.json"), "utf8"));
  meta.seasons = [{ year: 2027, events: 1 }, ...meta.seasons];
  const rk = { season: 2027, standings: { "World Class": { rows: [
    { rank: 1, corps: "Bluecoats", class: "World Class", score: 72.5, date: "2027-06-20",
      event: "First Show 2027", delta: null, prev_score: null, high: 72.5,
      high_event: "First Show 2027", high_date: "2027-06-20", trend: [["2027-06-20", 72.5]] },
    { rank: 2, corps: "Blue Devils", class: "World Class", score: 72.1, date: "2027-06-20",
      event: "First Show 2027", delta: null, prev_score: null, high: 72.1,
      high_event: "First Show 2027", high_date: "2027-06-20", trend: [["2027-06-20", 72.1]] },
  ] } } };
  const season27 = [{ name: "First Show 2027", date: "2027-06-20", location: "Akron, OH",
    classes: [{ class: "World Class", results: [
      { place: 1, corps: "Bluecoats", score: 72.5 }, { place: 2, corps: "Blue Devils", score: 72.1 }] }] }];
  await page.route("**/data/meta.json*", r => r.fulfill({ contentType: "application/json", body: JSON.stringify(meta) }));
  await page.route("**/data/rankings.json*", r => r.fulfill({ contentType: "application/json", body: JSON.stringify(rk) }));
  await page.route("**/data/seasons/2027.json*", r => r.fulfill({ contentType: "application/json", body: JSON.stringify(season27) }));
  await page.goHash("#/");
  const h1 = await page.textContent("h1.page");
  if (!/2027 Scoreboard/.test(h1)) bad(`scoreboard did not roll over: "${h1.trim()}"`);
  if (!/Bluecoats/.test(await page.textContent("#standings"))) bad("2027 standings not rendered");
  await page.goHash("#/events");
  await page.waitForTimeout(600);
  if (!/First Show 2027/.test(await page.textContent("#app"))) bad("2027 events not listed");
  if (page._errs.length) bad(page._errs[0]);
  await ctx.close();
});


/* Runtime layout — the class of bug that only a real browser finds, and that
   nothing else in this repo guards. Every one of these has already shipped
   once: an inline grid-template-columns that beat the phone breakpoint and
   clipped the WGI tiles to "Championshi"; `display: grid` on a class the
   scripts toggle with the hidden attribute, which rendered a whole profile
   editor underneath a signed-out page; and `#evlist > .card` matching every
   event row, so the Shows tab stayed one column at 1280 on all four apps. */
const APPS = ["", "wgi/guard/", "wgi/percussion/", "wgi/winds/"];

section("no page scrolls horizontally, on any app, at either width", async (browser, base) => {
  for (const app of APPS) {
    for (const viewport of [PHONE, DESKTOP]) {
      const { ctx, page } = await ctxPage(browser, base, { viewport });
      for (const r of ["#/", "#/events", "#/corps", "#/stats"]) {
        await page.goto(`${base}/${app}${r}`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(900);
        const over = await page.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 1) bad(`/${app}${r} @${viewport.width}: page scrolls ${over}px horizontally`);
      }
      await ctx.close();
    }
  }
});

section("the hidden attribute actually hides", async (browser, base) => {
  // an author `display` beats the UA sheet's [hidden] rule, so a grid/flex
  // class silently un-hides anything the scripts toggle
  for (const app of APPS) {
    const { ctx, page } = await ctxPage(browser, base, { viewport: DESKTOP });
    await page.goto(`${base}/${app}#/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll("[hidden]")]
        .filter(el => getComputedStyle(el).display !== "none")
        .map(el => el.tagName.toLowerCase() + "." + (String(el.className) || "?").slice(0, 40)));
    if (shown.length) bad(`/${app}: ${shown.length} [hidden] element(s) still rendering: ${shown.slice(0, 3).join(", ")}`);
    await ctx.close();
  }
});

section("desktop layouts engage at 1280", async (browser, base) => {
  const { ctx, page } = await ctxPage(browser, base, { viewport: DESKTOP });
  const cols = async (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).gridTemplateColumns : null;
  }, sel);
  const multi = (v) => !!v && v.trim().split(/\s+/).length > 1;

  await page.goto(`${base}/#/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  if (!multi(await cols(".rk-grid"))) bad("scoreboard .rk-grid is a single column at 1280");

  await page.goto(`${base}/#/events`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  if (!multi(await cols("#evlist"))) bad("#evlist is a single column at 1280");
  // …and the rows must actually sit in those tracks rather than spanning both
  const spanned = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#evlist .evrow")];
    return rows.filter(r => getComputedStyle(r).gridColumnStart === "1" &&
                            getComputedStyle(r).gridColumnEnd === "-1").length;
  });
  if (spanned > 0) bad(`#evlist: ${spanned} event row(s) span both columns, so Shows renders one-up`);

  await page.goto(`${base}/#/corps/bluecoats`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  if (!multi(await cols("#corpsDetail"))) bad("#corpsDetail is a single column at 1280");
  await ctx.close();
});

// ---------------------------------------------------------------------------
(async () => {
  const { srv, port } = await start();
  const base = `http://127.0.0.1:${port}`;
  const browser = await pw.chromium.launch({ executablePath: EXECUTABLE });
  const t0 = Date.now();
  for (const [name, fn] of sections) {
    currentSection = name;
    const n0 = findings.length;
    const s0 = Date.now();
    try { await fn(browser, base); }
    catch (e) { bad("CRASHED: " + e.message.slice(0, 200)); }
    const dt = ((Date.now() - s0) / 1000).toFixed(1);
    console.log(`${findings.length === n0 ? "  ok " : "  FAIL"} ${name} (${dt}s)`);
  }
  await browser.close();
  srv.close();
  console.log(`\n${sections.length} sections in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (findings.length) {
    console.log(`\n${findings.length} finding(s):`);
    findings.forEach(f => console.log("  - " + f));
    process.exit(1);
  }
  console.log("QA CLEAN");
})();
