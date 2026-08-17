/* Channel providers for the Cadence notification worker.
 *
 * Both are inert until configured, and both report honestly through the
 * worker's contract: `configured: false` → the row is 'skipped' with a
 * clear reason; a dead endpoint / bounced address → `{gone: true}` so the
 * queue never retries it forever. Unit tests drive them with a fake fetch
 * (notify-providers.check.js) — no network, no keys.
 *
 * EMAIL — a Resend adapter (https://resend.com, simple REST + free tier).
 * Turns on with RESEND_API_KEY + NOTIFY_FROM_EMAIL. The from address must
 * be a domain verified in Resend; until the owner has one, the channel
 * stays off and invites remain copy-link (which always works).
 *
 * WORKSPACE PUSH — reuses the relay's existing web-push transport, but
 * targeted: subscriptions registered per-user via POST /subscribe-user
 * (JWT-verified server-side), stored user_id → [subscriptions]. The worker
 * resolves a queue row's recipient_member_id to its user_id through the
 * service role, then pushes to every registered browser.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/* ── email (Resend) ──────────────────────────────────────────────────── */
export function emailProvider({ fetchImpl, apiKey, from }) {
  const configured = !!(apiKey && from);
  return {
    configured,
    async send(n, msg) {
      const to = n.recipient_email;
      if (!to) return { gone: true };               // nothing to deliver to
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [to],
          subject: msg.subject,
          text: `${msg.title}\n\n${msg.body}\n\n${msg.url}\n`,
        }),
      });
      if (res.status === 422) return { gone: true }; // invalid address — don't retry
      if (!res.ok) throw new Error(`resend ${res.status}`);
      return {};
    },
  };
}

/* ── workspace push (user-linked web-push) ───────────────────────────── */
export function userSubsStore(dataDir) {
  const file = path.join(dataDir, "user-push-subs.json");
  function read() {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return {}; }
  }
  function write(all) {
    fs.writeFileSync(file, JSON.stringify(all));
  }
  return {
    add(userId, sub) {
      const all = read();
      const list = all[userId] || [];
      if (!list.some((s) => s.endpoint === sub.endpoint)) list.push(sub);
      all[userId] = list.slice(-5);                  // a person has a few devices, not fifty
      write(all);
    },
    remove(userId, endpoint) {
      const all = read();
      all[userId] = (all[userId] || []).filter((s) => s.endpoint !== endpoint);
      if (!all[userId].length) delete all[userId];
      write(all);
    },
    get(userId) { return read()[userId] || []; },
    prune(userId, endpoint) { this.remove(userId, endpoint); },
  };
}

export function workspacePushProvider({ webpush, dataDir, sbUrl, serviceKey, fetchImpl }) {
  const store = userSubsStore(dataDir);
  return {
    configured: true,     // transport always exists; a member with no
    _store: store,        // registered browser simply reports {gone}
    async send(n, msg) {
      // queue rows carry the member; resolve to the account (service role)
      const res = await fetchImpl(
        `${sbUrl}/rest/v1/org_members?id=eq.${n.recipient_member_id}&select=user_id`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      const rows = res.ok ? await res.json() : [];
      const userId = rows[0] && rows[0].user_id;
      if (!userId) return { gone: true };
      const subs = store.get(userId);
      if (!subs.length) return { gone: true };       // no browser registered — not an error
      let delivered = 0;
      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub, JSON.stringify({
            title: msg.title, body: msg.body, url: msg.url, tag: `cad-ens-${n.type}`,
          }));
          delivered++;
        } catch (e) {
          if (e && (e.statusCode === 404 || e.statusCode === 410)) {
            store.prune(userId, sub.endpoint);       // dead endpoint — forget it
          } else { throw e; }                        // transient — let the queue retry
        }
      }
      return delivered ? {} : { gone: true };
    },
  };
}

/* ── Supabase JWT verification for /subscribe-user ───────────────────────
 * Supabase signs access tokens HS256 with the project's JWT secret
 * (Dashboard → Settings → API → JWT secret; server-side only, like the
 * service key). Returns the user id or null — never throws. */
export function verifySupabaseJwt(token, secret, now = () => Date.now()) {
  try {
    if (!token || !secret) return null;
    const [h, p, sig] = String(token).split(".");
    if (!h || !p || !sig) return null;
    const expect = crypto.createHmac("sha256", secret)
      .update(`${h}.${p}`).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    if (!claims.sub || (claims.exp && claims.exp * 1000 < now())) return null;
    return claims.sub;
  } catch (e) { return null; }
}
