#!/usr/bin/env node
/* Regression guards for invite deep links (findings #1 / #8 / #14).
 *
 * The bug: docs/ensemble/people.js copied index.html?invite=CODE, the
 * notification worker emailed /ensemble/?join=CODE, and the join page read
 * neither — every invite link landed on an empty code box. This suite pulls
 * the real functions out of the shipped sources and runs them, so it fails
 * if either generator drifts or the parser stops reading a param.
 *
 *   node scripts/test_invite_links.js
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const pass = [], fail = [];
const ok = (cond, msg) => (cond ? pass : fail).push(msg);

// pull a chunk of source out of a shipped file, loudly if it moved
function slice(file, re, what) {
  const m = read(file).match(re);
  if (!m) { console.log(`FAIL 1\n  FAIL could not find ${what} in ${file}`); process.exit(1); }
  return m[0];
}

// the join page's URL parser + the sign-in-hop parking helpers, verbatim
const joinSrc = slice("docs/ensemble/index.html",
  /\n {2}var INVITE_KEY[\s\S]*?\n {2}function takeParkedInvite\(\)[\s\S]*?\n {2}\}\n/,
  "the invite-link helper block");
function joinPage(storage) {
  return new Function("localStorage",
    joinSrc + "\nreturn { inviteFromUrl: inviteFromUrl, parkInvite: parkInvite, " +
    "takeParkedInvite: takeParkedInvite };")(storage);
}

// people.js's link generator, verbatim, with a stand-in location
const inviteUrlSrc = slice("docs/ensemble/people.js",
  /\n {2}function inviteUrl\(code\)[\s\S]*?\n {2}\}\n/, "inviteUrl()");
const inviteUrl = new Function("location",
  inviteUrlSrc + "\nreturn inviteUrl;")({ href: "https://cadence.test/ensemble/members.html?org=7" });

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

(async () => {
  const { inviteFromUrl, parkInvite, takeParkedInvite } = joinPage(fakeStorage());
  const worker = await import(pathToFileURL(path.join(ROOT, "push-server/notify-worker.js")).href);
  const workerUrl = (code) =>
    worker.render({ type: "invite", payload: { org_name: "R", code: code } }, "https://cadence.test/").url;

  // ── the join page reads both params ─────────────────────────────────
  ok(inviteFromUrl("?invite=AB12-CD34") === "AB12-CD34", "index.html reads ?invite=");
  ok(inviteFromUrl("?join=AB12-CD34") === "AB12-CD34", "index.html reads the legacy ?join=");
  ok(inviteFromUrl("?org=7&join=AB12-CD34") === "AB12-CD34", "index.html finds the code beside other params");
  ok(inviteFromUrl("?invite=NEW1&join=OLD1") === "NEW1", "index.html prefers ?invite= when both are present");
  ok(inviteFromUrl("?invite=%20AB12%20") === "AB12", "index.html trims a padded code");
  ok(inviteFromUrl("?org=7") === "" && inviteFromUrl("") === "", "index.html yields nothing without a code");

  // ── the code survives the magic-link sign-in hop, exactly once ──────
  {
    const store = fakeStorage();
    const p = joinPage(store);
    p.parkInvite("AB12-CD34");
    ok(p.takeParkedInvite() === "AB12-CD34", "a parked code survives the sign-in redirect");
    ok(p.takeParkedInvite() === "", "a parked code is consumed once, not re-offered");
    store.setItem("cad-pending-invite", JSON.stringify({ code: "STALE1", at: Date.now() - 8 * 864e5 }));
    ok(p.takeParkedInvite() === "", "a code parked over a week ago is dropped, not prefilled");
    ok(joinPage({ getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); } }).takeParkedInvite() === "",
      "blocked storage degrades quietly instead of throwing");
  }

  // ── both generators emit the one agreed format ──────────────────────
  ok(inviteUrl("AB12-CD34") === "https://cadence.test/ensemble/index.html?invite=AB12-CD34",
    "people.js inviteUrl() builds index.html?invite=");
  ok(workerUrl("AB12-CD34") === "https://cadence.test/ensemble/index.html?invite=AB12-CD34",
    "notify-worker render() builds the same index.html?invite= link");
  ok(inviteUrl("AB12-CD34").replace("https://cadence.test/ensemble/", "") ===
    workerUrl("AB12-CD34").replace("https://cadence.test/ensemble/", ""),
    "the copied link and the emailed link agree character for character");
  ok(!/ensemble\/\?join=/.test(read("push-server/notify-worker.js")),
    "notify-worker.js no longer emits the dead /ensemble/?join= link");

  // ── a URL-hostile code makes the whole round trip intact ────────────
  {
    const nasty = "A B&C=D?E#F+G/H%I";
    [["people.js", inviteUrl(nasty)], ["notify-worker", workerUrl(nasty)]].forEach((pair) => {
      const search = new URL(pair[1]).search;
      ok(inviteFromUrl(search) === nasty, `${pair[0]}: a URL-hostile code round-trips to the join box`);
    });
    ok(inviteFromUrl(new URL(inviteUrl("A+B")).search) === "A+B",
      "a '+' in a code stays a '+' and is not decoded to a space");
  }

  // ── the page is actually wired up, and does not auto-redeem ─────────
  {
    const index = read("docs/ensemble/index.html");
    ok(/inviteFromUrl\(location\.search\)/.test(index), "index.html reads the code off the live URL at boot");
    ok(/getElementById\("joinCode"\)\.value = code/.test(index), "index.html prefills #joinCode with it");
    ok((index.match(/rpc\("redeem_org_invite"/g) || []).length === 1 &&
      /addEventListener\("submit"[\s\S]*?rpc\("redeem_org_invite"/.test(index),
      "index.html redeems only from the submit handler — an invite link never enrols on load");
    ok(/P\.inviteUrl\(/.test(read("docs/ensemble/members.html")),
      "members.html's copy-link button still goes through people.js inviteUrl()");
  }

  console.log(`PASS ${pass.length}`);
  pass.forEach((m) => console.log("  ok   " + m));
  if (fail.length) {
    console.log(`FAIL ${fail.length}`);
    fail.forEach((m) => console.log("  FAIL " + m));
    process.exit(1);
  }
})();
