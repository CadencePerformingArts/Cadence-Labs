#!/usr/bin/env node
/* Tests for the preference-sync merge rule (docs/account.js).
 *
 *   node scripts/test_sync_merge.js
 *
 * The resurrection bug: deletions were server row-deletes, so any device
 * that missed one saw "server doesn't know this key" and pushed its stale
 * copy back. The fix is last-writer-wins with tombstones, decided by one
 * pure function (CadAccount._lww). This exercises the whole decision table
 * plus a two-device simulation of the exact scenarios the audit named.
 */
const fs = require("fs");
const path = require("path");

// minimal globals so account.js loads (no Supabase config -> early return
// after exposing the pure decision function)
global.window = {};
const src = fs.readFileSync(path.join(__dirname, "..", "docs", "account.js"), "utf8");
new Function(src)();
const lww = global.window.CadAccount && global.window.CadAccount._lww;

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

ok(typeof lww === "function", "account.js exposes the _lww decision function");
if (typeof lww !== "function") { report(); }

/* ── the decision table, exhaustively ─────────────────────────────────── */
// never synced
ok(lww(false, null, 0, "x", 5) === "push-local", "unsynced local value goes up");
ok(lww(false, null, 0, null, 0) === "noop", "nothing anywhere is a noop");
// tombstones
ok(lww(true, null, 10, "x", 5) === "remove-local", "newer tombstone removes the local copy");
ok(lww(true, null, 5, "x", 10) === "push-local", "local write after the delete wins (value returns)");
ok(lww(true, null, 7, null, 3) === "noop", "tombstone with nothing local is a noop");
ok(lww(true, null, 5, "x", 5) === "remove-local", "tie goes to the server (deterministic)");
// values
ok(lww(true, "a", 10, "b", 5) === "apply-server", "newer server value applies");
ok(lww(true, "a", 5, "b", 10) === "push-local", "newer local value pushes");
ok(lww(true, "a", 5, "a", 99) === "noop", "equal values are a noop regardless of time");
ok(lww(true, "a", 0, "b", 0) === "apply-server", "legacy rows (no t) tie to the server");

/* ── two-device simulation of the audit scenarios ─────────────────────── */
// a tiny model of the sync protocol: each device holds {local, meta}; the
// server holds rows {v|null, t}. push() writes values/tombstones; pull()
// applies the lww decision. This mirrors pushDirty()/pull() exactly.
function device() { return { local: {}, meta: {} }; }
function set(d, k, v, t) { d.local[k] = v; d.meta[k] = t; }
function del(d, k, t) { delete d.local[k]; d.meta[k] = t; }
function push(d, server, keys) {
  keys.forEach((k) => {
    const t = d.meta[k] || 0;
    server[k] = k in d.local ? { v: d.local[k], t } : { v: null, t };
  });
}
function pull(d, server) {
  const pushBack = [];
  for (const k of Object.keys(server)) {
    const s = server[k];
    const decision = lww(true, s.v, s.t, k in d.local ? d.local[k] : null, d.meta[k] || 0);
    if (decision === "apply-server") { d.local[k] = s.v; d.meta[k] = s.t; }
    else if (decision === "remove-local") { delete d.local[k]; d.meta[k] = s.t; }
    else if (decision === "push-local") pushBack.push(k);
  }
  for (const k of Object.keys(d.local)) if (!(k in server)) pushBack.push(k);
  return pushBack;
}

// 1. deletion propagates and does NOT resurrect
{
  const server = {}, A = device(), B = device();
  set(A, "cad-theme", "dark", 100); push(A, server, ["cad-theme"]);
  pull(B, server);
  ok(B.local["cad-theme"] === "dark", "sim: value syncs A -> B");
  del(A, "cad-theme", 200); push(A, server, ["cad-theme"]);
  const back = pull(B, server);
  ok(!("cad-theme" in B.local), "sim: deletion propagates to B");
  ok(back.length === 0, "sim: B does NOT push the deleted key back (no resurrection)");
  const back2 = pull(B, server);
  ok(back2.length === 0 && !("cad-theme" in B.local), "sim: stable across repeated pulls");
}

// 2. a later write beats an earlier delete (the value comes back on purpose)
{
  const server = {}, A = device(), B = device();
  set(A, "cad-fontsize", "1.1", 100); push(A, server, ["cad-fontsize"]);
  pull(B, server);
  del(A, "cad-fontsize", 200); push(A, server, ["cad-fontsize"]);
  set(B, "cad-fontsize", "1.25", 300);            // B writes after A's delete
  const back = pull(B, server);
  ok(back.includes("cad-fontsize"), "sim: newer local write survives the tombstone");
  push(B, server, back);
  pull(A, server);
  ok(A.local["cad-fontsize"] === "1.25", "sim: A converges to B's newer value");
}

// 3. favorites deletion propagates (whole-key LWW replaced the union that
//    re-added removed stars)
{
  const server = {}, A = device(), B = device();
  set(A, "cad-favs", '["Blue Devils","Bluecoats"]', 100); push(A, server, ["cad-favs"]);
  pull(B, server);
  set(A, "cad-favs", '["Bluecoats"]', 200);       // A un-stars Blue Devils
  push(A, server, ["cad-favs"]);
  pull(B, server);
  ok(B.local["cad-favs"] === '["Bluecoats"]', "sim: un-starring propagates (union no longer resurrects)");
}

// 4. deterministic convergence when both edit offline
{
  const server = {}, A = device(), B = device();
  set(A, "cad-notify-scope", "favs", 500);
  set(B, "cad-notify-scope", "all", 400);
  push(A, server, ["cad-notify-scope"]);
  const backB = pull(B, server);
  ok(backB.length === 0 && B.local["cad-notify-scope"] === "favs",
    "sim: older concurrent edit yields to the newer one");
}

/* ── source-level guards for the atomic favorites mirror ──────────────── */
{
  const s = src;
  const upsertAt = s.indexOf('sb.from("favorites").upsert');
  const deleteAt = s.indexOf('sb.from("favorites").delete');
  ok(upsertAt > 0 && deleteAt > upsertAt,
    "source: favorites mirror upserts BEFORE pruning (no empty window)");
  ok(!/favorites"\)\.delete\(\)[\s\S]{0,120}\.insert\(/.test(s),
    "source: no wipe-then-insert favorites path remains");
  ok(/\{ del: 1, t: t \}/.test(s), "source: deletions push tombstones, not row-deletes");
  ok(!/preferences"\)\.delete\(\)/.test(s), "source: preferences rows are never deleted");
}

report();
function report() {
  console.log(`PASS ${pass.length}`);
  pass.forEach((m) => console.log("  ok   " + m));
  if (fail.length) {
    console.log(`FAIL ${fail.length}`);
    fail.forEach((m) => console.log("  FAIL " + m));
    process.exit(1);
  }
  process.exit(0);
}
