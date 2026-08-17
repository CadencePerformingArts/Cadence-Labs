/* Cadence push relay.
   Polls the published site data every couple of minutes; when new scores
   appear, sends one Web Push to every subscriber (personalized with their
   favorite corps' scores when possible).

   Deploy: Railway (or any Node host). PORT is provided by the platform.
   Persistence: attach a volume and it lands in RAILWAY_VOLUME_MOUNT_PATH;
   without one, keys/subs live in ./data (survive restarts, not redeploys —
   set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars to pin keys forever). */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";

const VERSION = 15; // bump on every behavior change — /status shows what's really deployed
const SITE = process.env.SITE_URL || "https://cadenceperformingarts.github.io/Cadence-Labs/";
const PORT = process.env.PORT || 8787;
const POLL_MS = +(process.env.POLL_SECONDS || 60) * 1000;
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || "./data";
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- VAPID keys: env > saved > freshly generated ----
const keyFile = path.join(DATA_DIR, "vapid.json");
let keys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else if (fs.existsSync(keyFile)) {
  keys = JSON.parse(fs.readFileSync(keyFile, "utf8"));
} else {
  keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(keyFile, JSON.stringify(keys));
  console.log("generated new VAPID keys -> " + keyFile);
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:lucasbesel41@gmail.com",
  keys.publicKey, keys.privateKey);

// ---- subscriptions ----
const subsFile = path.join(DATA_DIR, "subs.json");
let subs = new Map(); // endpoint -> {sub, favs}
try {
  for (const s of JSON.parse(fs.readFileSync(subsFile, "utf8"))) subs.set(s.sub.endpoint, s);
} catch {}
const saveSubs = () => {
  try { fs.writeFileSync(subsFile, JSON.stringify([...subs.values()])); }
  catch (e) { console.error("saveSubs failed:", e.message); }
};

// ---- score watching ----
// the baseline persists on the volume: a restart mid-show can't blind the
// relay to scores that posted while it was rebooting
const stateFile = path.join(DATA_DIR, "state.json");
let lastState = null;   // corps -> "date|event|score" per class
try { lastState = new Map(JSON.parse(fs.readFileSync(stateFile, "utf8"))); } catch {}
const saveState = () => {
  try { fs.writeFileSync(stateFile, JSON.stringify([...lastState])); }
  catch (e) { console.error("saveState failed:", e.message); }
};

// notified-events ledger — the anti-spam guard.
// raw.githubusercontent serves inconsistent CDN edges for a couple minutes
// after each push, so a poll can see a new show's scores appear, revert to the
// prior edge, then reappear — and the naive "differs from last poll" check
// fires a fresh alert on every flap. Keying "already alerted" on the show
// itself (event|date), seeded from whatever's live at boot, makes alerts
// idempotent: exactly one ping per genuinely-new show, and a revert to any
// show we've already seen never fires again. Persisted so a restart mid-show
// doesn't re-alert everything.
const notifiedFile = path.join(DATA_DIR, "notified.json");
let notified = new Set();
try { notified = new Set(JSON.parse(fs.readFileSync(notifiedFile, "utf8"))); } catch {}
const saveNotified = () => {
  try { fs.writeFileSync(notifiedFile, JSON.stringify([...notified].slice(-4000))); }
  catch (e) { console.error("saveNotified failed:", e.message); }
};
// event|date keys present in a snapshot (values are "date|event|score")
function eventKeysOf(state) {
  const keys = new Set();
  if (state) for (const val of state.values()) {
    const [date, event] = val.split("|");
    if (event) keys.add(event + "|" + date);
  }
  return keys;
}

let status = { lastCheck: null, lastChange: null, lastError: null, sent: 0 };
let relayBucket = 10, relayStamp = Date.now(); // token bucket for /fetch

// Read scores from the SAME place the app does — the published GitHub Pages
// site — so an alert can only fire once the new scores are actually live in
// the app (and the deep-linked show page has them). We previously read
// raw.githubusercontent for a ~1-2 min head start, but that fired alerts
// before the app had caught up, so a tapped alert showed stale scores.
// Correctness beats the head start. SITE ends in "/"; Pages serves docs/ as root.
const DATA_BASE = process.env.DATA_URL || SITE;
async function fetchJson(p) {
  // unique query per poll so nothing serves a stale body
  const r = await fetch(`${DATA_BASE}${p}?cb=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
  if (!r.ok) throw new Error(p + " " + r.status);
  return r.json();
}

function snapshot(rk) {
  const state = new Map();
  for (const [cls, block] of Object.entries(rk.standings || {})) {
    for (const row of block.rows || []) {
      state.set(cls + "|" + row.corps, `${row.date}|${row.event}|${row.score}`);
    }
  }
  return state;
}

async function check() {
  try {
    const rk = await fetchJson("data/rankings.json");
    status.lastCheck = new Date().toISOString();
    const state = snapshot(rk);
    // seed the ledger once so nothing already live at boot ever alerts (from
    // the last-seen baseline if we have one, else current data)
    if (!notified.size) { notified = eventKeysOf(lastState || state); saveNotified(); }
    if (lastState) {
      // which events produced new scores since last look?
      const events = new Map(); // "event|date" -> [{corps, score, cls}]
      for (const [key, val] of state) {
        if (lastState.get(key) === val) continue;
        const parts = key.split("|");
        const cls = parts[0];                       // state key is "class|corps"
        const corps = parts.slice(1).join("|");
        const [date, event, score] = val.split("|");
        const ek = event + "|" + date;
        if (notified.has(ek)) continue;             // already alerted this show — ignore flaps/reverts
        if (!events.has(ek)) events.set(ek, []);
        events.get(ek).push({ corps, score: +score, cls });
      }
      if (events.size) {
        status.lastChange = new Date().toISOString();
        for (const ek of events.keys()) notified.add(ek); // mark before send so a flap mid-broadcast can't re-fire
        saveNotified();
        await broadcast(events);
      }
    }
    lastState = state;
    saveState();
  } catch (e) {
    status.lastError = `${new Date().toISOString()} ${e.message}`;
  }
}

async function broadcast(events) {
  const jobs = [];
  for (const { sub, favs, favsOnly, classes } of subs.values()) {
    // class filter: null/absent = every class; an array = only those picked
    const clsSet = Array.isArray(classes) ? new Set(classes) : null;
    const favList = favs || [];
    const favSet = new Set(favList);
    // ONE alert PER SHOW, each deep-linked to that show's own page — so tapping
    // any notification always opens that show's score breakdown, never the list.
    for (const [ek, rows] of events) {
      const fr = clsSet ? rows.filter(r => clsSet.has(r.cls)) : rows;
      if (!fr.length) continue;                                   // none of the classes they follow
      if (favsOnly && !fr.some(r => favSet.has(r.corps))) continue; // no followed corps in this show

      const parts = ek.split("|");                                // ek = "event|date"
      const dt = parts.pop(), name = parts.join("|"), yr = (dt || "").slice(0, 4);
      const sorted = [...fr].sort((a, b) => b.score - a.score);
      // favorites first: if one of the subscriber's corps scored here, lead with it
      const mine = favList.map(f => fr.find(r => r.corps === f)).filter(Boolean);
      const body = (mine.length ? mine : sorted).slice(0, 3)
        .map(r => `${r.corps} ${r.score.toFixed(3)}`).join(" · ");

      // #/go turns the show's name+date into its exact event page (the app
      // matches name AND date, so two shows on one day still resolve precisely).
      const url = yr
        ? `${SITE}#/go?y=${yr}&d=${encodeURIComponent(dt)}&e=${encodeURIComponent(name)}`
        : SITE;
      // tag keyed to the show so each show is its own tappable alert, and a
      // re-post for the same show replaces (and re-chimes) its earlier one
      const payload = JSON.stringify({ title: `🥁 Scores in: ${name}`, body, url, tag: "cadence-scores:" + name });
      jobs.push(webpush.sendNotification(sub, payload).then(
        () => { status.sent++; },
        err => {
          status.lastPushError = `${new Date().toISOString()} ${err.statusCode || ""} ${err.message}`;
          if ([401, 403, 404, 410].includes(err.statusCode)) {
            subs.delete(sub.endpoint); // gone, or bound to a rotated key
          }
        }));
    }
  }
  await Promise.allSettled(jobs);
  saveSubs();
  console.log(`pushed ${jobs.length} notifications`);
}

// Adaptive cadence: poll hard on show days (a show today or last night, for
// late West-Coast results) so a score drop pushes within ~25s of the commit;
// idle the rest of the time. showToday is refreshed from the upcoming feed.
let showToday = false;
const SHOW_POLL = 25_000, IDLE_POLL = 120_000;
async function refreshShowFlag() {
  try {
    const up = await fetchJson("data/upcoming.json");
    const day = ms => new Date(ms).toISOString().slice(0, 10);
    const now = Date.now();
    const days = new Set([day(now), day(now - 864e5)]);
    showToday = Array.isArray(up) && up.some(e => days.has(e.date));
  } catch (e) { /* keep prior flag */ }
}
(async function poll() {
  await check();
  setTimeout(poll, showToday ? SHOW_POLL : IDLE_POLL);
})();
refreshShowFlag();
setInterval(refreshShowFlag, 15 * 60 * 1000);

// ---- ask: grounded LLM Q&A over the published scores ----
// A fan can ask a plain-English question ("did Pacific Crest pass Madison
// Scouts, and when?") and get an answer grounded ONLY in the official scores.
// Guarded end to end: with no ANTHROPIC_API_KEY the endpoint reports "disabled"
// and the push relay is completely unaffected. Model is swappable via ASK_MODEL
// (defaults to Haiku — cheap and fast for grounded lookups over structured data).
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const ASK_MODEL = process.env.ASK_MODEL || "claude-haiku-4-5";
const ASK_MAX_TOKENS = +(process.env.ASK_MAX_TOKENS || 700);
const ASK_DAILY_CAP = +(process.env.ASK_DAILY_CAP || 1500);        // global ceiling / day
const ASK_BURST = +(process.env.ASK_BURST || 5);                  // per-IP questions before throttling
const ASK_REFILL_MS = +(process.env.ASK_REFILL_SECONDS || 15) * 1000; // one back every N seconds
const DEFAULT_YEAR = new Date().getUTCFullYear();
let anthropic = null;
if (ANTHROPIC_KEY) {
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
    console.log(`assistant enabled — model ${ASK_MODEL}`);
  } catch (e) {
    console.error("assistant init failed (is @anthropic-ai/sdk installed?):", e.message);
  }
} else {
  console.log("assistant disabled — set ANTHROPIC_API_KEY to enable /ask");
}
let askStat = { answered: 0, blocked: 0, lastAsk: null, lastError: null };

const fmtScore = s => (s == null || isNaN(s)) ? "—" : (+s).toFixed(3).replace(/\.?0+$/, "");

// season detail — rebuilt at most every 10 min per year (new scores land there)
const seasonCache = new Map(); // year -> { text, ts }
async function seasonContext(year) {
  const hit = seasonCache.get(year);
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.text;
  const evs = await fetchJson(`data/seasons/${year}.json`);
  const out = [
    `${year} DCI SEASON — official DCI.org scores (out of 100; a higher score places higher).`,
    `Every ${year} show in date order, with each division's placements and scores.`,
    "",
  ];
  for (const ev of [...evs].sort((a, b) => (a.date || "").localeCompare(b.date || ""))) {
    out.push(`[${ev.date || "????-??-??"}] ${ev.name}${ev.location ? " — " + ev.location : ""}`);
    for (const cls of ev.classes || []) {
      const rows = (cls.results || []).map(r => `${r.place}. ${r.corps} ${fmtScore(r.score)}`).join("; ");
      if (rows) out.push(`  ${cls.class}: ${rows}`);
    }
    out.push("");
  }
  const text = out.join("\n");
  seasonCache.set(year, { text, ts: Date.now() });
  return text;
}

// all-time champions — essentially static, cache an hour
let champsText = null, champsTs = 0;
async function championsContext() {
  if (champsText && Date.now() - champsTs < 60 * 60 * 1000) return champsText;
  const ch = await fetchJson("data/champions.json");
  const out = ["DCI CHAMPIONS BY YEAR (the season's championship winner in each division):"];
  for (const y of Object.keys(ch).sort()) {
    const parts = [];
    for (const [cls, v] of Object.entries(ch[y] || {}))
      if (v && v.corps) parts.push(`${cls}: ${v.corps}${v.score != null ? ` (${fmtScore(v.score)})` : ""}`);
    if (parts.length) out.push(`${y} — ${parts.join("; ")}`);
  }
  champsText = out.join("\n"); champsTs = Date.now();
  return champsText;
}

function askSystem(year, today) {
  return [
    "You are Cadence's scores assistant. Cadence is a free app that tracks Drum Corps International (DCI) competition scores.",
    `Answer the fan's question using ONLY the data below. Full show-by-show detail covers the ${year} season; the champions list covers every year.`,
    "How to answer:",
    "- Lead with the direct answer in one sentence, then a short supporting detail. Conversational, a few sentences at most. No markdown headings.",
    "- Scores are out of 100 and a higher score places higher. World Class is the top division; Open Class and All-Age are separate divisions — keep them apart unless asked to compare.",
    "- \"Did X pass Y?\" means Y was ahead at an earlier show and X moved ahead at a later one. Name the show and date where the lead flipped, and the margin.",
    "- Always cite the show name and date for a result, and use the exact scores from the data — never invent, estimate, or round-guess a score.",
    `- You only have full detail for the ${year} season plus all-time champions. If asked about a corps, show, or season that isn't in the data, say so briefly instead of guessing.`,
    `Today's date is ${today}.`,
  ].join("\n");
}

// cost guards: a per-IP token bucket + a global daily ceiling
const askBuckets = new Map();
function askAllow(ip) {
  const now = Date.now();
  if (askBuckets.size > 5000) for (const [k, v] of askBuckets) if (now - v.ts > 36e5) askBuckets.delete(k);
  let b = askBuckets.get(ip);
  if (!b) { b = { tokens: ASK_BURST, ts: now }; askBuckets.set(ip, b); }
  b.tokens = Math.min(ASK_BURST, b.tokens + (now - b.ts) / ASK_REFILL_MS);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1; return true;
}
let askDay = { day: "", n: 0 };
function askUnderDailyCap() {
  const d = new Date().toISOString().slice(0, 10);
  if (askDay.day !== d) askDay = { day: d, n: 0 };
  if (askDay.n >= ASK_DAILY_CAP) return false;
  askDay.n++; return true;
}

// ---- tiny HTTP API ----
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const send = (res, code, obj) =>
  res.writeHead(code, { "content-type": "application/json", ...CORS }).end(JSON.stringify(obj));

// a bad request or disk hiccup must answer 500, never kill the process
process.on("uncaughtException", e => console.error("uncaught:", e));
process.on("unhandledRejection", e => console.error("unhandled:", e));

http.createServer(async (req, res) => {
  try {
  if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
  const url = new URL(req.url, "http://x");
  let body = "";
  for await (const chunk of req) body += chunk;
  let json = {};
  try { json = body ? JSON.parse(body) : {}; } catch {}

  if (req.method === "GET" && url.pathname === "/") {
    // humans who click the relay's URL should land on the app itself
    return res.writeHead(302, { Location: SITE, ...CORS }).end();
  }
  if (req.method === "GET" && url.pathname === "/status") {
    return send(res, 200, { ok: true, service: "cadence-push", version: VERSION,
      volume: !!process.env.RAILWAY_VOLUME_MOUNT_PATH, dataDir: DATA_DIR,
      subscribers: subs.size, notifiedShows: notified.size, source: DATA_BASE,
      ask: { enabled: !!anthropic, model: ASK_MODEL, ...askStat }, ...status });
  }
  if (req.method === "GET" && url.pathname === "/vapid") {
    return send(res, 200, { key: keys.publicKey });
  }
  if (req.method === "GET" && url.pathname === "/fetch") {
    // dci.org-only fetch relay: GitHub's runner IPs started getting a
    // blanket Cloudflare challenge from dci.org, so the scraper routes its
    // reads through this box instead. Hard-restricted to public dci.org
    // pages and rate-limited — this is not a general proxy.
    let target;
    try { target = new URL(url.searchParams.get("url") || ""); } catch {}
    if (!target || target.protocol !== "https:" || target.hostname !== "www.dci.org") {
      return send(res, 400, { error: "only https://www.dci.org/ urls" });
    }
    relayBucket = Math.min(relayBucket + (Date.now() - relayStamp) / 1500, 10);
    relayStamp = Date.now();
    if (relayBucket < 1) {
      return res.writeHead(429, { "retry-after": "5", ...CORS }).end("relay rate limit");
    }
    relayBucket -= 1;
    try {
      const up = await fetch(target, {
        redirect: "follow",
        signal: AbortSignal.timeout(25000),
        headers: { "user-agent": "cadence-relay/1 (+https://github.com/CadencePerformingArts/Cadence-Labs)" },
      });
      const text = await up.text();
      status.lastRelay = `${new Date().toISOString()} ${up.status} ${target.pathname}`;
      const h = { "content-type": up.headers.get("content-type") || "text/html",
        "cache-control": "no-store", ...CORS };
      const ra = up.headers.get("retry-after");
      if (ra) h["retry-after"] = ra;
      const cfm = up.headers.get("cf-mitigated");
      if (cfm) h["cf-mitigated"] = cfm;
      return res.writeHead(up.status, h).end(text);
    } catch (e) {
      status.lastRelay = `${new Date().toISOString()} ERR ${e.message}`;
      return res.writeHead(502, CORS).end("relay fetch failed: " + e.message);
    }
  }
  if (req.method === "POST" && url.pathname === "/subscribe") {
    const sub = json.subscription;
    if (!sub || !sub.endpoint) return send(res, 400, { error: "subscription required" });
    subs.set(sub.endpoint, {
      sub,
      favs: Array.isArray(json.favs) ? json.favs.slice(0, 30) : [],
      favsOnly: !!json.favsOnly,
      classes: Array.isArray(json.classes) ? json.classes.slice(0, 8) : null,
    });
    saveSubs();
    return send(res, 200, { ok: true, subscribers: subs.size });
  }
  if (req.method === "POST" && url.pathname === "/unsubscribe") {
    if (json.endpoint) { subs.delete(json.endpoint); saveSubs(); }
    return send(res, 200, { ok: true, subscribers: subs.size });
  }
  if (req.method === "POST" && url.pathname === "/test") {
    const entry = json.endpoint && subs.get(json.endpoint);
    if (!entry) return send(res, 404, { error: "not subscribed" });
    // a short delay lets the user leave the app first — iOS won't banner a
    // push that lands while the app is in the foreground
    const delay = Math.min(Math.max(+json.delay || 0, 0), 30000);
    setTimeout(async () => {
      try {
        await webpush.sendNotification(entry.sub, JSON.stringify({
          title: "🥁 Cadence test", body: "Score alerts are working — you're all set.", url: SITE,
          tag: "cadence-test",
        }));
        status.sent++;
      } catch (e) {
        status.lastPushError = `${new Date().toISOString()} ${e.statusCode || ""} ${e.message}`;
        if ([401, 403, 404, 410].includes(e.statusCode)) { subs.delete(entry.sub.endpoint); saveSubs(); }
      }
    }, delay);
    return send(res, 200, { ok: true, queued: true, delay });
  }
  if (req.method === "POST" && url.pathname === "/ask") {
    if (!anthropic) return send(res, 503, { error: "The assistant isn't switched on yet." });
    const q = (typeof json.q === "string" ? json.q : "").trim();
    if (!q) return send(res, 400, { error: "Ask a question about DCI scores." });
    if (q.length > 500) return send(res, 400, { error: "That question's a bit long — keep it under 500 characters." });
    let year = parseInt(json.year, 10);
    if (!(year >= 1972 && year <= DEFAULT_YEAR + 1)) year = DEFAULT_YEAR;
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
      || req.socket.remoteAddress || "?";
    if (!askAllow(ip)) { askStat.blocked++; return send(res, 429, { error: "One at a time! Give it a few seconds and ask again." }); }
    if (!askUnderDailyCap()) { askStat.blocked++; return send(res, 429, { error: "The assistant has hit today's question limit — try again tomorrow." }); }
    // short follow-up memory: the client replays the last few turns
    const hist = Array.isArray(json.history)
      ? json.history
          .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-6).map(m => ({ role: m.role, content: m.content.slice(0, 1200) }))
      : [];
    const messages = [...hist, { role: "user", content: q }];
    while (messages.length && messages[0].role !== "user") messages.shift();
    try {
      const [season, champs] = await Promise.all([seasonContext(year), championsContext()]);
      const msg = await anthropic.messages.create({
        model: ASK_MODEL,
        max_tokens: ASK_MAX_TOKENS,
        system: [
          { type: "text", text: askSystem(year, new Date().toISOString().slice(0, 10)) },
          { type: "text", text: champs },
          // cache the biggest, most stable block so repeat questions are cheap
          { type: "text", text: season, cache_control: { type: "ephemeral" } },
        ],
        messages,
      });
      const answer = (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      askStat.answered++;
      askStat.lastAsk = new Date().toISOString();
      return send(res, 200, { answer: answer || "I couldn't find an answer to that in the scores.", year, model: ASK_MODEL });
    } catch (e) {
      askStat.lastError = `${new Date().toISOString()} ${e.status || ""} ${e.message}`;
      return send(res, 502, { error: "The assistant had trouble just now — try again in a moment." });
    }
  }
  send(res, 404, { error: "not found" });
  } catch (e) {
    console.error("request failed:", e.message);
    try { send(res, 500, { error: "internal" }); } catch (e2) {}
  }
}).listen(PORT, () => console.log(`cadence-push on :${PORT} — watching ${SITE}`));

/* ── workspace notification drain (opt-in, inert without config) ────────
   Drains the org_notifications queue (migration 0014) through the worker.
   Runs ONLY when a service-role key is present, so an existing score-push
   deployment is unaffected until the owner sets these env vars. Push and
   email providers are wired here as they are configured; unconfigured
   channels are skipped cleanly, never retried forever. */
(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return; // notifications not enabled on this deployment
  const { runOnce, supabaseDb, fakeProviders } = await import("./notify-worker.js");
  const db = supabaseDb(fetch, url, key);
  // in-app is always deliverable (it's just the queue row the client reads);
  // push/email are wired as real providers when their config lands. Until
  // then they are marked unconfigured and skipped, not failed.
  const providers = {
    inapp: { configured: true, async send() { return {}; } },
    push: { configured: false },
    email: { configured: false },
  };
  const NOTIFY_MS = +(process.env.NOTIFY_POLL_SECONDS || 30) * 1000;
  async function drain() {
    try {
      const r = await runOnce({ db, providers, siteUrl: SITE });
      if (r.sent || r.failed) console.log("notify drain:", JSON.stringify(r));
    } catch (e) { console.error("notify drain failed:", e.message); }
  }
  setInterval(drain, NOTIFY_MS);
  console.log(`notification worker on — draining every ${NOTIFY_MS / 1000}s`);
})();
