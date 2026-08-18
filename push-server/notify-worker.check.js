/* Tests for the notification worker — deterministic, no network.
 *
 *   node push-server/notify-worker.check.js
 *
 * A fake in-memory queue stands in for the Supabase RPCs, so we can prove
 * the delivery contract exactly: sends once, retries with backoff, dead-
 * letters after MAX_ATTEMPTS, skips unconfigured channels and dead
 * endpoints, and never double-sends a row already marked terminal.
 */
import { runOnce, render, fakeProviders, MAX_ATTEMPTS } from "./notify-worker.js";

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// a fake queue: claim() returns pending+due rows (marking attempts++),
// mark()/reschedule() mutate them, exactly like the real RPCs
function fakeQueue(rows, clock) {
  return {
    rows,
    claim(limit) {
      const due = rows.filter((r) => r.status === "pending" && r.scheduled_at <= clock.now)
        .slice(0, limit);
      due.forEach((r) => (r.attempts = (r.attempts || 0) + 1));
      return Promise.resolve(due.map((r) => ({ ...r })));
    },
    mark(id, status, error) {
      const r = rows.find((x) => x.id === id);
      r.status = status; r.last_error = error || null;
      if (status === "sent") r.sent_at = clock.now;
      return Promise.resolve();
    },
    reschedule(id, whenIso, error) {
      const r = rows.find((x) => x.id === id);
      r.status = "pending"; r.scheduled_at = Date.parse(whenIso); r.last_error = error;
      return Promise.resolve();
    },
  };
}

(async () => {
  // ── happy path: one row per channel, sent exactly once ──────────────
  {
    const clock = { now: 1000 };
    const rows = [
      { id: "a", channel: "inapp", type: "ack_post", attempts: 0, status: "pending", scheduled_at: 0, payload: { post_id: "p1", title: "Bus at 6" } },
      { id: "b", channel: "email", type: "invite", attempts: 0, status: "pending", scheduled_at: 0, payload: { org_name: "Riverside", code: "X" } },
    ];
    const providers = fakeProviders();
    const db = fakeQueue(rows, clock);
    const r = await runOnce({ db, providers, siteUrl: "https://x/", now: () => clock.now });
    ok(r.sent === 2, `happy: 2 sent (got ${r.sent})`);
    ok(providers._sent.inapp.length === 1 && providers._sent.email.length === 1, "happy: one send per channel");
    ok(rows.every((x) => x.status === "sent"), "happy: rows marked sent");
    // a second drain finds nothing pending — no double send
    const r2 = await runOnce({ db, providers, siteUrl: "https://x/", now: () => clock.now });
    ok(r2.sent === 0 && providers._sent.inapp.length === 1, "idempotent: no double-send on re-drain");
  }

  // ── retry with backoff, then dead-letter ────────────────────────────
  {
    const clock = { now: 0 };
    const rows = [{ id: "z", channel: "push", type: "rsvp", attempts: 0, status: "pending", scheduled_at: 0, payload: {} }];
    const providers = fakeProviders();
    providers.push = { configured: true, async send() { throw new Error("boom"); } };
    const db = fakeQueue(rows, clock);
    let rescheduled = 0, failed = 0;
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      const r = await runOnce({ db, providers, siteUrl: "https://x/", now: () => clock.now });
      rescheduled += r.rescheduled; failed += r.failed;
      clock.now += 24 * 3600 * 1000; // jump past any backoff so it's due again
    }
    ok(failed === 1, `retry: dead-letters exactly once (got ${failed})`);
    ok(rows[0].status === "failed", "retry: final status is failed");
    ok(rescheduled === MAX_ATTEMPTS - 1, `retry: rescheduled MAX_ATTEMPTS-1 times before failing (got ${rescheduled})`);
  }

  // ── unconfigured channel is skipped, not retried ────────────────────
  {
    const clock = { now: 0 };
    const rows = [{ id: "s", channel: "email", type: "invite", attempts: 0, status: "pending", scheduled_at: 0, payload: {} }];
    const providers = fakeProviders();
    providers.email = { configured: false };
    const db = fakeQueue(rows, clock);
    const r = await runOnce({ db, providers, siteUrl: "https://x/", now: () => clock.now });
    ok(r.skipped === 1 && rows[0].status === "skipped", "unconfigured: channel skipped");
  }

  // ── dead endpoint (gone) is skipped, not failed ─────────────────────
  {
    const clock = { now: 0 };
    const rows = [{ id: "g", channel: "push", type: "ack_post", attempts: 0, status: "pending", scheduled_at: 0, payload: {} }];
    const providers = fakeProviders();
    providers.push = { configured: true, async send() { return { gone: true }; } };
    const db = fakeQueue(rows, clock);
    const r = await runOnce({ db, providers, siteUrl: "https://x/", now: () => clock.now });
    ok(r.skipped === 1 && rows[0].status === "skipped", "gone endpoint: skipped");
  }

  // ── templates carry no sensitive content and build the right link ───
  {
    const t = render({ type: "ack_post", payload: { post_id: "p9", title: "Title only" } }, "https://s/");
    ok(t.url === "https://s/ensemble/feed.html#post-p9", "template: ack link is correct");
    ok(!/medical|coordinate|acknowledge me privately/i.test(Object.values(t).join(" ")), "template values leak no sensitive source content");
    const inv = render({ type: "invite", payload: { org_name: "R", code: "abc" } }, "https://s/");
    ok(inv.url === "https://s/ensemble/index.html?invite=abc",
      "template: invite link is the canonical index.html?invite= form the join page reads");
    const enc = render({ type: "invite", payload: { org_name: "R", code: "a b&c" } }, "https://s/");
    ok(enc.url === "https://s/ensemble/index.html?invite=a%20b%26c",
      "template: invite code is percent-encoded into the link");
  }

  console.log(`PASS ${pass.length}`);
  pass.forEach((m) => console.log("  ok   " + m));
  if (fail.length) { console.log(`FAIL ${fail.length}`); fail.forEach((m) => console.log("  FAIL " + m)); process.exit(1); }
})();
