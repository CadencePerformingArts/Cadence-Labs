#!/usr/bin/env node
/* Tests for the notification channel providers — fake fetch, fake webpush,
 * a temp dir for the subscription store, a made-up JWT secret. No network.
 *
 *   node push-server/notify-providers.check.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { emailProvider, workspacePushProvider, userSubsStore, verifySupabaseJwt }
  from "./notify-providers.js";

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cad-prov-"));

(async () => {
  /* ── email ──────────────────────────────────────────────────────────── */
  ok(!emailProvider({ fetchImpl: fetch, apiKey: null, from: null }).configured,
    "email: unconfigured without key+from");
  {
    const calls = [];
    const p = emailProvider({
      fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
      apiKey: "re_test", from: "Cadence <no-reply@example.com>",
    });
    ok(p.configured, "email: configured with key+from");
    await p.send({ recipient_email: "kid@example.com" },
      { subject: "S", title: "T", body: "B", url: "https://x/join" });
    ok(calls.length === 1 && calls[0].url.includes("api.resend.com"), "email: calls the provider");
    ok(calls[0].body.to[0] === "kid@example.com" && /https:\/\/x\/join/.test(calls[0].body.text),
      "email: right recipient, link in body");
    const gone = await p.send({ recipient_email: null }, { subject: "s" });
    ok(gone.gone === true, "email: no address reports gone, not failure");
    const invalid = await emailProvider({
      fetchImpl: async () => ({ ok: false, status: 422 }), apiKey: "k", from: "f",
    }).send({ recipient_email: "bad" }, { subject: "s", title: "", body: "", url: "" });
    ok(invalid.gone === true, "email: invalid address (422) reports gone");
    let threw = false;
    try {
      await emailProvider({ fetchImpl: async () => ({ ok: false, status: 500 }), apiKey: "k", from: "f" })
        .send({ recipient_email: "x@y.z" }, { subject: "s", title: "", body: "", url: "" });
    } catch (e) { threw = true; }
    ok(threw, "email: provider 500 throws so the queue retries");
  }

  /* ── subscription store ─────────────────────────────────────────────── */
  {
    const store = userSubsStore(tmp);
    store.add("u1", { endpoint: "https://p/1", keys: {} });
    store.add("u1", { endpoint: "https://p/1", keys: {} });   // dupe
    store.add("u1", { endpoint: "https://p/2", keys: {} });
    ok(store.get("u1").length === 2, "store: dedupes by endpoint");
    store.remove("u1", "https://p/1");
    ok(store.get("u1").length === 1, "store: removes by endpoint");
    ok(store.get("nobody").length === 0, "store: unknown user is empty");
  }

  /* ── workspace push ─────────────────────────────────────────────────── */
  {
    const pushTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cad-prov-push-"));
    const sent = [], deadEndpoints = new Set(["https://p/dead"]);
    const webpush = { async sendNotification(sub, payload) {
      if (deadEndpoints.has(sub.endpoint)) { const e = new Error("gone"); e.statusCode = 410; throw e; }
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    } };
    const p = workspacePushProvider({
      webpush, dataDir: pushTmp, sbUrl: "https://sb", serviceKey: "svc",
      fetchImpl: async (url) => ({ ok: true, json: async () =>
        url.includes("member-with-user") ? [{ user_id: "u1" }] : [] }),
    });
    p._store.add("u1", { endpoint: "https://p/live" });
    p._store.add("u1", { endpoint: "https://p/dead" });
    const r = await p.send({ recipient_member_id: "member-with-user", type: "ack_post" },
      { title: "T", body: "B", url: "https://x" });
    ok(!r.gone && sent.length === 1 && sent[0].payload.title === "T",
      "push: delivers to the live browser");
    ok(p._store.get("u1").length === 1 && p._store.get("u1")[0].endpoint === "https://p/live",
      "push: prunes the dead endpoint (410)");
    const noUser = await p.send({ recipient_member_id: "ghost" }, { title: "t" });
    ok(noUser.gone === true, "push: unknown member reports gone");
    p._store.remove("u1", "https://p/live");
    const noSubs = await p.send({ recipient_member_id: "member-with-user" }, { title: "t" });
    ok(noSubs.gone === true, "push: member with no registered browser reports gone");
    fs.rmSync(pushTmp, { recursive: true, force: true });
  }

  /* ── JWT verification ───────────────────────────────────────────────── */
  {
    const secret = "sb-jwt-test-secret";
    const now = 1_700_000_000_000;
    function makeJwt(claims, key) {
      const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const hp = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(claims)}`;
      return `${hp}.${crypto.createHmac("sha256", key).update(hp).digest("base64url")}`;
    }
    const good = makeJwt({ sub: "user-1", exp: now / 1000 + 3600 }, secret);
    ok(verifySupabaseJwt(good, secret, () => now) === "user-1", "jwt: valid token yields the user id");
    ok(verifySupabaseJwt(good, "wrong-secret", () => now) === null, "jwt: wrong secret rejected");
    const expired = makeJwt({ sub: "user-1", exp: now / 1000 - 10 }, secret);
    ok(verifySupabaseJwt(expired, secret, () => now) === null, "jwt: expired token rejected");
    const forged = good.slice(0, -4) + "AAAA";
    ok(verifySupabaseJwt(forged, secret, () => now) === null, "jwt: tampered signature rejected");
    ok(verifySupabaseJwt("garbage", secret, () => now) === null, "jwt: garbage rejected");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`PASS ${pass.length}`);
  pass.forEach((m) => console.log("  ok   " + m));
  if (fail.length) { console.log(`FAIL ${fail.length}`); fail.forEach((m) => console.log("  FAIL " + m)); process.exit(1); }
})();
