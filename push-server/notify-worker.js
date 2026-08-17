/* Cadence notification worker.
 *
 * Drains the org_notifications queue (migration 0014) through channel
 * provider adapters. Runs server-side with the Supabase SERVICE ROLE — never
 * in the browser. It is written dependency-injected: `runOnce` takes a db
 * client and a set of providers, so the whole thing is unit-testable with
 * deterministic fakes and no network (see notify-worker.test.js).
 *
 * Guarantees:
 *   • idempotent — the queue's dedupe index means a row is enqueued once;
 *     the worker marks each row terminal ('sent'/'skipped') or reschedules
 *     it with backoff, so a restart mid-batch never double-sends a 'sent' row
 *   • bounded retries — a failing row backs off (attempts drive the delay)
 *     until MAX_ATTEMPTS, then it dead-letters as 'failed'
 *   • safe payloads — templates use only queue payload fields (titles,
 *     names, links, counts). Push copy for anything sensitive stays generic
 *   • dead push-endpoint pruning — a provider may report {gone:true} and the
 *     row is 'skipped', not retried forever
 *
 * Real deployment wires `supabaseDb()` (service-role RPC calls) and real
 * providers (web-push, an email provider). With no providers configured a
 * channel is 'skipped' with a clear reason — the app stays usable without
 * email or push set up.
 */

export const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [0, 60_000, 300_000, 1_800_000, 7_200_000]; // 0,1m,5m,30m,2h

/* ── safe templates: queue payload -> what a channel actually shows ───── */
export function render(n, siteUrl) {
  const base = (siteUrl || "").replace(/\/+$/, "");
  const p = n.payload || {};
  switch (n.type) {
    case "invite":
      return {
        subject: `You're invited to ${p.org_name || "a Cadence workspace"}`,
        title: `Join ${p.org_name || "your group"} on Cadence`,
        body: "Tap to accept your invitation and sign in.",
        url: `${base}/ensemble/?join=${encodeURIComponent(p.code || "")}`,
      };
    case "ack_post":
      return {
        subject: "An announcement needs your acknowledgment",
        // generic-but-useful; the title field is already length-capped and
        // carries no body text
        title: p.title || "New announcement",
        body: "Please read and acknowledge.",
        url: `${base}/ensemble/feed.html#post-${p.post_id || ""}`,
      };
    case "rsvp":
      return {
        subject: "Please RSVP",
        title: p.title || "New event",
        body: "Your group needs to know if you're coming.",
        url: `${base}/ensemble/event.html?id=${p.event_id || ""}`,
      };
    default:
      return { subject: "Cadence", title: "Cadence", body: "", url: base + "/ensemble/" };
  }
}

/* ── the drain: claim due rows, deliver, mark ────────────────────────── */
export async function runOnce({ db, providers, siteUrl, now = () => Date.now(), limit = 50 }) {
  const rows = await db.claim(limit);
  const result = { sent: 0, skipped: 0, failed: 0, rescheduled: 0 };

  for (const n of rows) {
    const provider = providers[n.channel];
    const msg = render(n, siteUrl);
    try {
      if (!provider || !provider.configured) {
        // channel not set up on this deployment — don't retry forever
        await db.mark(n.id, "skipped", `${n.channel} provider not configured`);
        result.skipped++;
        continue;
      }
      const out = await provider.send(n, msg);
      if (out && out.gone) {
        // dead push endpoint / bounced address — terminal, not a failure
        await db.mark(n.id, "skipped", "recipient endpoint gone");
        result.skipped++;
      } else {
        await db.mark(n.id, "sent");
        result.sent++;
      }
    } catch (err) {
      const attempts = n.attempts || 0; // claim already incremented this
      if (attempts >= MAX_ATTEMPTS) {
        await db.mark(n.id, "failed", String(err && err.message || err).slice(0, 200));
        result.failed++;
      } else {
        const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
        await db.reschedule(n.id, new Date(now() + delay).toISOString(),
          String(err && err.message || err).slice(0, 200));
        result.rescheduled++;
      }
    }
  }
  return result;
}

/* ── providers ───────────────────────────────────────────────────────── */

// deterministic fakes for tests and for a deployment with nothing wired
export function fakeProviders() {
  const sent = { inapp: [], push: [], email: [] };
  return {
    _sent: sent,
    inapp: { configured: true, async send(n) { sent.inapp.push(n.id); return {}; } },
    push: { configured: true, async send(n) { sent.push.push(n.id); return {}; } },
    email: { configured: true, async send(n) { sent.email.push(n.id); return {}; } },
  };
}

// a Supabase service-role db adapter (used in real deployment). Kept here so
// the worker is complete; requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
export function supabaseDb(fetchImpl, url, serviceKey) {
  const rpc = async (fn, body) => {
    const res = await fetchImpl(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error(`rpc ${fn} ${res.status}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  };
  return {
    claim: (limit) => rpc("claim_notifications", { p_limit: limit }),
    mark: (id, status, error) => rpc("mark_notification", { p_id: id, p_status: status, p_error: error || null }),
    // reschedule is a mark back to pending with a new time — done via a
    // dedicated PATCH so scheduled_at moves (service role bypasses RLS)
    reschedule: async (id, whenIso, error) => {
      const res = await fetchImpl(
        `${url}/rest/v1/org_notifications?id=eq.${id}`,
        {
          method: "PATCH",
          headers: {
            apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json", Prefer: "return=minimal",
          },
          body: JSON.stringify({ status: "pending", scheduled_at: whenIso, last_error: (error || "").slice(0, 300) }),
        });
      if (!res.ok) throw new Error(`reschedule ${res.status}`);
    },
  };
}
