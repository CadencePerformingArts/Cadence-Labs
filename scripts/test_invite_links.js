#!/usr/bin/env node
/* Regression guards for invite deep links (findings #1 / #8 / #14).
 *
 * The bug: docs/ensemble/people.js copied index.html?invite=CODE, the
 * notification worker emailed /ensemble/?join=CODE, and the join page read
 * neither — every invite link landed on an empty code box. This suite pulls
 * the real functions out of the shipped sources and runs them, so it fails
 * if either generator drifts or the parser stops reading a param.
 *
 * It also runs the join page's whole inline script against a stub DOM, so
 * the "an invite link never enrols you on load" promise is checked by
 * watching for the RPC rather than by grepping for it. Grep cannot tell the
 * difference between an rpc call sitting in a submit handler and the same
 * call reached from the prefill path.
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
const bail = (msg) => { console.log(`FAIL 1\n  FAIL ${msg}`); process.exit(1); };

// pull a chunk of source out of a shipped file, loudly if it moved
function slice(file, re, what) {
  const m = read(file).match(re);
  if (!m) bail(`could not find ${what} in ${file}`);
  return m[0];
}

// the join page's URL parser + the sign-in-hop parking helpers, verbatim
const joinSrc = slice("docs/ensemble/index.html",
  /\n {2}var INVITE_KEY[\s\S]*?\n {2}function takeParkedInvite\([\s\S]*?\n {2}\}\n/,
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
const blockedStorage = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("blocked"); },
  removeItem() { throw new Error("blocked"); },
};

/* ── the join page's inline script, run for real ───────────────────────
 * index.html ships one inline <script> that boots the page (plus the tiny
 * theme shim in <head>). We execute it against a stub DOM and a stub
 * CadOrg, then look at what it actually did: which elements it wrote,
 * what it focused, and every CadOrg.rpc() it made and when. */
const INDEX = read("docs/ensemble/index.html");
const pageScripts = (INDEX.match(/<script>[\s\S]*?<\/script>/g) || [])
  .map((s) => s.slice("<script>".length, -"</script>".length))
  .filter((s) => /CadOrg\.start\(/.test(s));
if (pageScripts.length !== 1) bail(`expected exactly 1 boot script in index.html, found ${pageScripts.length}`);
const runPage = new Function("window", "document", "location", "localStorage",
  "CadOrg", "CadAccount", pageScripts[0]);

const ALWAYS_MOUNTED = ["ensMain"];
const SIGNED_IN_IDS = ["joinForm", "joinCode", "joinMsg", "newForm", "newName", "newType", "newMsg"];
const SIGNED_OUT_IDS = ["ensSignIn", "ensEmail", "ensMsg"]; // core.js's magic-link gate

function fakePage(opts) {
  const state = { phase: "load" };          // "load" until a test acts as the user
  const log = [];                           // focus calls, missing lookups
  const rpcCalls = [];
  const storage = opts.storage || fakeStorage();
  const els = new Map();

  function el(id) {
    if (els.has(id)) return els.get(id);
    const e = {
      id, value: "", className: "", textContent: "", innerHTML: "", handlers: {},
      addEventListener(type, fn) { (e.handlers[type] = e.handlers[type] || []).push(fn); },
      fire(type) {
        const ev = { type, target: e, preventDefault() {}, stopPropagation() {} };
        return Promise.all((e.handlers[type] || []).map((fn) => fn(ev)));
      },
      focus() { log.push({ kind: "focus", id }); },
      // the page wires the community Join buttons with querySelectorAll; a
      // stub that returns nothing would let a broken selector pass silently,
      // so it resolves the one selector the page actually uses
      querySelectorAll(sel) {
        if (!/^\[data-join-public\]$/.test(sel)) return [];
        // resolve against what this element actually rendered, not against
        // the fixture — render() runs once before the community list has
        // loaded, and a stub that hands back buttons anyway would wire the
        // handler twice and hide a double-join
        const ids = [...String(e.innerHTML).matchAll(/data-join-public="([^"]+)"/g)].map((x) => x[1]);
        return ids.map((id) => joinBtn(id));
      },
      querySelector(sel) {
        const m = /^\[data-join-msg="(.+)"\]$/.exec(sel);
        return m ? el("joinMsg:" + m[1]) : (log.push({ kind: "missing", sel }), null);
      },
      // a real <form> and a real type="submit" button both do this
      requestSubmit() { return e.fire("submit"); },
      submit() { return e.fire("submit"); },
      click() { return e.fire("submit"); },
    };
    els.set(id, e);
    return e;
  }

  function joinBtn(orgId) {
    const b = el("joinBtn:" + orgId);
    b.dataset = { joinPublic: orgId };
    b.click = () => b.fire("click");
    return b;
  }

  const mounted = ALWAYS_MOUNTED.concat(opts.user ? SIGNED_IN_IDS : SIGNED_OUT_IDS);
  const document = {
    getElementById: (id) =>
      (mounted.indexOf(id) >= 0 ? el(id) : (log.push({ kind: "missing", id }), null)),
    querySelector: (sel) =>
      (sel === "#joinForm button" && opts.user
        ? el("joinForm button")
        : (log.push({ kind: "missing", sel }), null)),
    documentElement: { dataset: {}, style: {} },
    addEventListener() {},
  };
  // the submit button behaves like the real one: activating it submits the form
  const btn = el("joinForm button");
  btn.click = btn.requestSubmit = btn.submit = () => el("joinForm").fire("submit");

  const location = {
    search: opts.search || "",
    origin: "https://cadence.test",
    pathname: "/ensemble/index.html",
    href: "https://cadence.test/ensemble/index.html" + (opts.search || ""),
  };

  const CadOrg = {
    esc: (s) => String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
    orgs: () => opts.orgs || [],
    trialDaysLeft: () => 0,
    isWritable: () => true,
    planOf: () => ({ label: "Free" }),
    mountShell() {},
    start: () => Promise.resolve(opts.user || null),
    rpc(name, args) {
      rpcCalls.push({ name, args, phase: state.phase });
      if (name === "list_public_orgs") {
        return opts.communitiesFail ? Promise.reject(new Error("PGRST202"))
                                    : Promise.resolve(opts.communities || []);
      }
      return Promise.resolve(42);
    },
    rest: () => Promise.resolve([{ id: 42 }]),
  };
  const CadAccount = { user: () => opts.user || null };

  runPage({}, document, location, storage, CadOrg, CadAccount);

  return {
    el, log, rpcCalls, location, storage, state, joinBtn,
    // the promise is "opening a link never ENROLS you" — reading the list of
    // open communities is not an enrolment, so the guard names the two calls
    // that actually change state rather than counting every rpc
    writes: () => rpcCalls.filter((c) => c.name === "redeem_org_invite" || c.name === "join_public_org"),
    text: (id) => el(id).textContent,
    focuses: () => log.filter((e) => e.kind === "focus"),
    async settle() { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); },
  };
}

(async () => {
  const { inviteFromUrl } = joinPage(fakeStorage());
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

  // ── the park is a bearer token, so it is bound to one address ───────
  {
    const store = fakeStorage();
    const p = joinPage(store);

    p.parkInvite("AB12-CD34", "a@x.com");
    ok(p.takeParkedInvite("a@x.com") === "AB12-CD34", "a parked code survives the sign-in redirect");
    ok(p.takeParkedInvite("a@x.com") === "", "a parked code is consumed once, not re-offered");

    p.parkInvite("AB12-CD34", " A@X.com ");
    ok(p.takeParkedInvite("a@x.com") === "AB12-CD34", "the address match ignores case and stray spaces");

    p.parkInvite("AB12-CD34", "a@x.com");
    ok(p.takeParkedInvite("b@y.com") === "", "a parked code is refused to a different account on the same browser");
    ok(store.getItem("cad-pending-invite") === null,
      "...and a refused code is cleared, not left for the next person to trip over");

    p.parkInvite("NOBODY", "");
    ok(store.getItem("cad-pending-invite") === null, "a code is never parked without an address to bind it to");
    ok(p.takeParkedInvite("") === "" && p.takeParkedInvite(null) === "",
      "a signed-in session with no address on it gets nothing back");

    store.setItem("cad-pending-invite", JSON.stringify({ code: "FRESH1", at: Date.now() - 5 * 6e4, email: "a@x.com" }));
    ok(p.takeParkedInvite("a@x.com") === "FRESH1", "a code parked minutes ago is still good for the round trip");
    store.setItem("cad-pending-invite", JSON.stringify({ code: "STALE1", at: Date.now() - 2 * 36e5, email: "a@x.com" }));
    ok(p.takeParkedInvite("a@x.com") === "",
      "a code parked longer ago than the sign-in link itself lives is dropped, not prefilled");
    store.setItem("cad-pending-invite", JSON.stringify({ code: "OLD1", at: Date.now() }));
    ok(p.takeParkedInvite("a@x.com") === "",
      "a legacy park with no address on it is dropped rather than handed to whoever is signed in");

    const blocked = joinPage(blockedStorage);
    ok(blocked.takeParkedInvite("a@x.com") === "", "blocked storage degrades quietly instead of throwing");
    let threw = false;
    try { blocked.parkInvite("AB12", "a@x.com"); } catch (e) { threw = true; }
    ok(!threw, "parking into blocked storage degrades quietly too");
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

  // ── arriving on an invite link: prefilled, never redeemed ───────────
  {
    const p = fakePage({ user: { id: "u1", email: "a@x.com" }, search: "?invite=AB12-CD34" });
    await p.settle();

    ok(p.el("joinCode").value === "AB12-CD34", "the code off the live URL lands in #joinCode");
    ok(p.writes().length === 0,
      "loading an invite link calls nothing — it never enrols you before you act");
    ok(p.focuses().length === 0,
      "nothing is focused on load, so a stray Enter or Space cannot accept an invitation");

    const said = p.text("joinMsg");
    ok(/invited/i.test(said) && /join workspace/i.test(said), "#joinMsg explains why the box is filled");

    // the copy claims a direction, so check it against where things really are
    const html = p.el("ensMain").innerHTML;
    const boxAt = html.indexOf('id="joinCode"'), msgAt = html.indexOf('id="joinMsg"');
    ok(boxAt >= 0 && msgAt > boxAt, "the join box really is rendered above #joinMsg");
    ok(/\babove\b/i.test(said) && !/\bbelow\b/i.test(said),
      "...and #joinMsg points up at the form it sits underneath, not down");
    ok(/id="joinMsg"[^>]*role="status"/.test(html),
      "#joinMsg is still a live region, so the sentence explaining the prefill is announced");

    // now the user actually chooses to join
    p.state.phase = "submit";
    await p.el("joinForm button").click();
    await p.settle();
    ok(p.writes().length === 1 && p.writes()[0].name === "redeem_org_invite" &&
      p.writes()[0].phase === "submit" && p.writes()[0].args.p_code === "AB12-CD34",
      "choosing Join workspace redeems the prefilled code, once");
    ok(p.location.href === "home.html?org=42", "a successful redeem lands in the workspace");
  }

  // ── the sign-in round trip, bound to the address that asked for it ──
  {
    const store = fakeStorage();
    const out = fakePage({ user: null, search: "?invite=RT-1", storage: store });
    await out.settle();
    ok(out.writes().length === 0, "a signed-out visit redeems nothing");

    out.el("ensEmail").value = " A@X.com ";
    await out.el("ensSignIn").fire("submit");
    const parked = JSON.parse(store.getItem("cad-pending-invite") || "null");
    ok(parked && parked.code === "RT-1" && parked.email === "a@x.com",
      "asking for a sign-in link parks the code against that address");

    // back from the magic link: same person, query string stripped
    const back = fakePage({ user: { id: "u1", email: "A@X.com" }, search: "", storage: store });
    await back.settle();
    ok(back.el("joinCode").value === "RT-1",
      "the code survives the magic-link hop for the person who asked for the link");
    ok(store.getItem("cad-pending-invite") === null, "and the park is consumed, not left lying around");
    ok(back.writes().length === 0 && back.focuses().length === 0,
      "coming back signed in still redeems nothing and focuses nothing");
  }

  // ── a shared browser: the next account gets nothing ─────────────────
  {
    const store = fakeStorage();
    const alice = fakePage({ user: null, search: "?invite=RT-2", storage: store });
    await alice.settle();
    alice.el("ensEmail").value = "alice@x.com";
    await alice.el("ensSignIn").fire("submit");
    ok(store.getItem("cad-pending-invite") !== null, "alice's abandoned invite is parked");

    const bob = fakePage({ user: { id: "u2", email: "bob@y.com" }, search: "", storage: store });
    await bob.settle();
    ok(bob.el("joinCode").value === "",
      "a code parked by one person is never prefilled for the next account to sign in here");
    ok(bob.text("joinMsg") === "", "...and bob is told nothing about someone else's invitation");
    ok(bob.writes().length === 0 && bob.focuses().length === 0, "...and nothing is redeemed or focused for him");
  }

  // ── no invite in hand: the gate parks nothing ───────────────────────
  {
    const store = fakeStorage();
    const plain = fakePage({ user: null, search: "", storage: store });
    await plain.settle();
    plain.el("ensEmail").value = "c@z.com";
    await plain.el("ensSignIn").fire("submit");
    ok(store.getItem("cad-pending-invite") === null, "signing in without an invite link parks nothing");
  }

  /* ── open communities (0020) ────────────────────────────────────────
   * The one place on the private side anybody may walk into. It must be a
   * DELIBERATE tap like the invite path is — a card that joins you because
   * the page loaded would be the same defect as an auto-redeeming invite
   * link — and it must vanish rather than break on a project that has not
   * applied 0020. */
  {
    const FANS = { id: "org-fans", name: "Cadence DCI Fans", blurb: "Open to everyone.", members: 12 };

    const one = fakePage({ user: { id: "u1", email: "a@x.com" }, communities: [FANS] });
    await one.settle();
    ok(one.rpcCalls.some((c) => c.name === "list_public_orgs"),
      "communities: the page asks what open communities exist");
    ok(one.writes().length === 0,
      "communities: loading the page joins nothing — the tap is the consent");
    ok(one.el("ensMain").innerHTML.indexOf("Cadence DCI Fans") >= 0 &&
       one.el("ensMain").innerHTML.indexOf('data-join-public="org-fans"') >= 0,
      "communities: an open community renders with a Join button");
    ok(one.el("ensMain").innerHTML.indexOf("Open to all") >= 0,
      "communities: …and is labelled as open, not as another private workspace");

    await one.joinBtn("org-fans").fire("click");
    const w = one.writes();
    ok(w.length === 1 && w[0].name === "join_public_org" && w[0].args.p_org === "org-fans",
      "communities: choosing Join calls join_public_org once, for that community");
    ok(one.location.href.indexOf("home.html?org=") >= 0,
      "communities: a successful join lands in the workspace");

    // already a member: the card is not offered again
    const member = fakePage({
      user: { id: "u1", email: "a@x.com" }, communities: [FANS],
      orgs: [{ org: { id: "org-fans", name: "Cadence DCI Fans", status: "active", plan: "pro" },
               role: { name: "Guest" } }],
    });
    await member.settle();
    ok(member.el("ensMain").innerHTML.indexOf('data-join-public') < 0,
      "communities: a community you are already in is not offered again");

    // 0020 not applied: the RPC fails and the section simply is not there
    const bare = fakePage({ user: { id: "u1", email: "a@x.com" }, communitiesFail: true });
    await bare.settle();
    ok(bare.el("ensMain").innerHTML.indexOf('data-join-public') < 0,
      "communities: a project without 0020 renders no community card at all");
    ok(bare.el("ensMain").innerHTML.indexOf("Join with a code") >= 0,
      "communities: …and the rest of the page still works");
  }

  // ── the contracts index.html leans on in files it does not own ──────
  {
    const core = read("docs/ensemble/core.js");
    ok(/id="ensSignIn"/.test(core) && /id="ensEmail"/.test(core),
      "core.js's signed-out gate still uses the ids index.html hooks to park the code");
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
