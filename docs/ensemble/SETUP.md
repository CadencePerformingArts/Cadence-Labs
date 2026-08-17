# Cadence Ensemble — turning it on

Everything is built and merged. Two things stand between here and a working
workspace, and both are yours to click.

## 1. Apply the database migrations (required)

Supabase → **SQL Editor** → paste each file's whole contents, in this order,
running one at a time. All of them were verified applying cleanly, in this
order, against a real PostgreSQL 16 (51 tables, 50 RLS-protected, 125
policies, zero errors).

| # | File | What it adds |
|---|------|--------------|
| 1 | `supabase/migrations/0003_usage_analytics.sql` | screen-usage analytics (public side) |
| 2 | `supabase/migrations/0004_ensemble_pro.sql` | public ensemble profiles + claims |
| 3 | `supabase/migrations/0005_ensemble_core.sql` | workspaces, roles, permissions, members, groups, invites, seasons, audit, subscription fields |
| 4 | `supabase/migrations/0006_ensemble_comms.sql` | posts, acknowledgments, comments, reactions, chat, moderation, notification prefs |
| 5 | `supabase/migrations/0007_ensemble_ops.sql` | events, RSVP, attendance, itineraries, packing lists, signups, tasks, polls |
| 6 | `supabase/migrations/0008_ensemble_files.sql` | folders, files, music metadata, storage bucket + policies |
| 7 | `supabase/migrations/0009_ensemble_people.sql` | guardians, forms, billing contacts, invoices |
| 8 | `supabase/migrations/0010_harden_grants.sql` | advisor-pass grant hardening |
| 9 | `supabase/migrations/0011_drill.sql` | drill shows / performers / sets + dot claims |
| 10 | `supabase/migrations/0012_security_hardening.sql` | **security fixes — closes seven workspace vulnerabilities (see below)** |
| 11 | `supabase/migrations/0013_event_chats.sql` | event chat rooms |
| 12 | `supabase/migrations/0014_notifications.sql` | notification queue + enqueue triggers + worker RPCs |
| 13 | `supabase/migrations/0015_platform_admin.sql` | platform-admin RPCs + audit (powers admin-platform.html) |
| 14 | `supabase/migrations/0016_stripe_events.sql` | Stripe webhook idempotency ledger |

If files 3 and 4 were already applied earlier, skip them — the rest still run.

**Faster path:** instead of pasting each file, paste the generated bundle
`supabase/migrations/RUN_ENSEMBLE.sql` (everything from 0005 on) or
`RUN_ALL.sql` (everything). Each runs as one transaction, so a mistake rolls
back cleanly.

**0012 is the important one if you have an existing workspace database.** It
closes seven vulnerabilities found in an adversarial audit — most seriously,
a member being able to promote themselves to Owner. It is additive (it does
not rewrite any applied migration) and was verified applying onto the prior
schema. Apply it before inviting anyone you don't fully trust. The full
attack list and the tests that prove each fix are in
`scripts/test_db_security.py` — run `python3 scripts/test_db_security.py`
against a scratch database (never production) to see every check pass (59 as of 0016).

**One possible snag, in file 6 only.** The last block creates the private
`ensemble` storage bucket and its access policies. Some projects don't let the
SQL editor alter `storage.objects`; if you see *"must be owner of table
objects"*, do this instead:

1. Storage → **New bucket** → name `ensemble`, **Public = OFF**, size limit 500 MB.
2. Storage → **Policies** → bucket `ensemble` → New policy → "For full
   customization" → create four policies for role `authenticated`, pasting the
   four expressions from the bottom of `0008_ensemble_files.sql`.

The helper functions that those policies call always create fine, so this is
copy-paste, not rework.

## 2. Realtime (recommended, 30 seconds)

Chat and the live feed use Postgres change streams. File 4 tries to enable
them; confirm with Database → **Replication** → `supabase_realtime` and make
sure `messages` and `posts` are included.

---

## Then: run a real rehearsal through it

1. Open **/ensemble/** on the site, sign in, and **Create workspace**.
   You land on a 60-day trial with every feature unlocked.
2. Settings you'll want early: **Admin → Roles** (add your own, e.g. Battery
   Staff), **Members → Groups** (sections auto-join by role and section), and
   **Admin → Seasons**.
3. Invite people: **Members → Invite** for one person, or paste a roster CSV
   (`name,email,role,section`) for the whole band. Codes and links are
   copyable — nothing is emailed yet, so hand them out however you already do.
4. Link the workspace to its public Cadence identity (Admin → workspace
   settings: `public_app_key` + `public_ensemble_name`, e.g. `boa` +
   `Carroll HS (IN)`). Now **Calendar → Add a Cadence competition** prefills
   venue, date and your performance time — and after the show, the event page
   shows your official placement, score and captions.

## What the trial does when it ends

Nothing is deleted, ever. The workspace goes read-only: every announcement,
file, message and attendance record stays readable, and new posting/uploading
resumes the moment a plan is active. That behavior is enforced in the
database, not just the interface.

## Billing status, honestly

Plans and the school-invoice/purchase-order path are built and the pricing is
configurable in one place (`docs/ensemble/core.js` → `PLANS`). **Card
checkout is built but not switched on** — the server-side Checkout Session
and signature-verified webhook exist as edge functions
(`supabase/functions/stripe-checkout`, `stripe-webhook`) that you deploy
with TEST-mode keys when ready; until then the card button says so honestly
and the invoice path (now driven from `admin-platform.html`) is the working
route. Plan fields stay locked against client writes, so only the webhook
(service role) or the platform-admin RPCs can grant a plan.
