# Cadence Owner Runbook

This is the one document to open when you need to operate Cadence. Every
step here was verified against the repository as it exists. Where a task
needs a developer or an AI agent instead of you, it says so plainly.

## The 10-minute map

Cadence is four pieces. Each runs in a different place:

1. **The website** — everything in the `docs/` folder, served free by
   GitHub Pages at https://cadenceperformingarts.github.io/Cadence-Labs/.
   The "Deploy site" workflow republishes it after every change to `main`.
2. **The data pipeline** — GitHub Actions (GitHub's built-in job runner)
   scrapes real scores on a schedule ("cron" = a timer that runs a job
   automatically), commits them to the repository, and triggers a redeploy.
   You never run it by hand on a normal day.
3. **The database** — a Supabase project (hosted PostgreSQL) holding
   accounts, favorites, and the private Cadence Ensemble workspaces. The
   site talks to it with a *publishable* key that is safe to be public;
   every table is protected by row-level security rules in the database
   itself. The *service-role* key — the master key that bypasses those
   rules — must never appear in the repository or in any web page.
4. **The push relay** — a small Node service (`push-server/`) on Railway
   that watches the site and sends browser push notifications when new DCI
   scores land. It can also deliver workspace notifications (see below).

**What costs money today:** possibly only Railway, which bills a small
monthly amount depending on your plan. GitHub Pages and Actions are free
for public repositories, and the Supabase project fits its free tier.
**Later costs:** a custom domain, a Supabase paid plan if workspaces grow,
email/push providers, and Stripe's per-transaction fees once billing is
live. Nothing in this repository purchases anything automatically.

## Current status (2026-08-18)

Migrations **0001-0020 are applied** to the live project, storage policies
included, and your account holds the platform-admin role — so
`admin-platform.html` works for you right now. Trials and grace periods now
expire **on their own**, hourly, without anyone opening the admin page. Both
Stripe edge functions are deployed and deliberately inert until you supply
test-mode keys. The section below is the reference for future migrations and
for standing up a staging copy.

## The open community (Cadence DCI Fans)

Every other workspace is private: you get in with a code a director handed
you. **Cadence DCI Fans** is the one exception — anybody signed in can join
it with a single tap from `/ensemble/`, so a curious visitor can see what a
workspace is before being invited to one that matters.

It is deliberately **read-only for joiners**. They land in the `guest` role,
which carries exactly one permission: read announcements. No files, no chat,
no direct messages, no roster. That is not an oversight — every youth-safety
rule in the database is scoped to one organization, so an open workspace with
chat switched on is a public chat room that somebody has to moderate, and it
can contain minors. Widen it only deliberately, and only when you have
decided who moderates it.

Two things are worth knowing:

- **You cannot publish a workspace from the browser, and neither can a
  director.** `is_public` sits in the same locked set as the billing fields,
  because the org-update policy otherwise lets any admin PATCH their own row
  — a school band's roster would have been one checkbox from world-joinable.
  Making a workspace public is a SQL-editor act; the statement is at the
  bottom of `supabase/migrations/0020_public_communities.sql`.
- **Post to it as the owner.** You are the only member with permission to
  write. Announcements you post there are what every joiner sees.

To wind it down: `update public.organizations set is_public = false where
slug = 'dci-fans';` — existing members keep their access, and nobody new can
join. Nothing is ever deleted.

## Applying database migrations safely

A *migration* is a numbered SQL file in `supabase/migrations/` that
changes the database. They apply once each, in order, and are never edited
after being applied — mistakes are fixed by a new numbered file.

1. **Back up first.** Supabase dashboard → **Database → Backups**. Confirm
   a recent backup exists (paid plans take them automatically; if yours
   does not, take one from here first). This is also where you restore if
   something goes wrong.
2. **Open the SQL editor.** Supabase dashboard → **SQL Editor**.
3. **Paste in order.**
   - *Brand-new project:* paste all of `supabase/migrations/RUN_ALL.sql`.
   - *Existing project:* paste each new migration file you have not yet
     applied, one at a time, in numeric order (e.g. `0012`, then `0013`,
     then `0014`) — or paste `RUN_ENSEMBLE.sql` if only the workspace
     layer (0005 onward) is missing.
   - The two `RUN_*.sql` bundles are generated files; each runs as one
     transaction, so a failure rolls back cleanly instead of half-applying.
4. **CRITICAL — migration 0012.** It closes a privilege-escalation hole:
   before it, a workspace member could promote themselves to Owner. Apply
   0012 **before inviting anyone you don't fully trust** to a workspace.
5. **Testing is a developer/agent task.** `scripts/test_db_security.py`
   proves the security rules by replaying real attacks — but it boots its
   own disposable scratch database to do it. **Never point it (or any
   test) at the production project.** Ask a developer or agent to run it
   after any migration change; the expected result is all checks passing (64 as of migration 0018).

## Storage policies — DONE (kept for reference)

**Already applied on your project**: the private `ensemble` bucket has its
four access policies, so workspace file upload and download work. This had
been the one outstanding blocker — the SQL editor's role could not alter
`storage.objects`, so `0008`'s guarded block skipped silently and the
bucket sat with zero policies (RLS on, everything denied). It was applied
through the Supabase management API instead and is recorded as
`0017_storage_policies.sql`.

On a NEW project, if you ever see *"must be owner of table objects"*, run
0017 through an agent with Supabase access, or do it by hand:

1. Storage → **New bucket** → name `ensemble`, **Public = OFF**, file size
   limit 500 MB.
2. Storage → **Policies** → bucket `ensemble` → New policy → "For full
   customization" → create **four** policies for role `authenticated`,
   pasting the four expressions from the bottom of
   `supabase/migrations/0008_ensemble_files.sql`.

Full walkthrough with screenshots-level detail: `docs/ensemble/SETUP.md`.

## Turning on workspace notifications

The database already queues workspace notifications (invites, must-read
announcements, RSVP-required events). The push relay drains that queue —
but only after you give it database access:

1. In Railway, open the relay service → **Variables**. These two are what
   let it see the queue at all:
   - `SUPABASE_URL` — your project URL (Supabase → Settings → API).
   - `SUPABASE_SERVICE_ROLE_KEY` — the service-role key from the same
     page. **Server-side only. Never put this key in the repository, a
     web page, or anywhere a browser can see it.**
2. These decide which channels can actually deliver. Each one is optional
   and each is checked independently — a channel with no configuration is
   skipped cleanly rather than failing:
   - `RESEND_API_KEY` and `NOTIFY_FROM_EMAIL` — email delivery. Without
     them no invitation or announcement email is sent.
   - `SUPABASE_JWT_SECRET` (Supabase → Settings → API → JWT Settings) —
     workspace push. The relay uses it to verify that a browser
     registering for push really is the signed-in user; the user id comes
     from the verified token, never from the request body. Without it the
     registration endpoint answers `503` and workspace push cannot work,
     even though VAPID keys are already set for the public score alerts.
3. The relay checks the queue every 30 seconds (tunable with
   `NOTIFY_POLL_SECONDS`). Without step 1 it does nothing new at all, so
   the existing score-push service is unaffected either way.

**Be aware of what is honest here.** A queued notification with no
configured channel is marked `skipped`, not `failed` — deliberately, so a
half-configured relay does not fill the health tile with red. The flip side
is that "no errors" does not mean "delivered". Check
`admin-platform.html`'s health tile against what people actually received
before you trust the pipe.

## The platform admin screen (and the SQL fallbacks)

Once migration `0015` is applied, open
**https://cadenceperformingarts.github.io/Cadence-Labs/admin-platform.html**,
sign in with your owner account, and you can do all of this with buttons:
review claims, activate plans, extend trials, issue and mark invoices paid
(marking paid activates the plan automatically), run the subscription
sweep, and watch platform health.

**Your account already has this role** — no setup needed. (For reference,
the grant is one statement: `update public.profiles set role =
'platform_admin' where id = (select id from auth.users where email =
'YOUR-EMAIL');`. That row is the only thing that grants the page any power,
and members cannot grant it to themselves.) **Still worth doing:** turn on
MFA for that account in Supabase → Authentication before real money is
involved.

This page is live at the public URL now — the branch was merged and the
site redeployed on 2026-08-18.

The SQL statements below remain as emergency fallbacks — copy from the
migration comments, fill in the id or slug, and run.

**Approving an Ensemble Pro claim** (someone claims their group's public
profile): the top of `supabase/migrations/0004_ensemble_pro.sql` has the
queries — list pending claims (with the claimant's email), approve one
*after you have verified the person really represents the organization*,
or reject one.

**Activating a paid plan after an invoice is paid:** the bottom of
`supabase/migrations/0009_ensemble_people.sql` walks the invoice through
its states — issue it against the workspace's request, mark it `paid`,
then flip the organization to `active`. The plan-activation statement
itself (plan, status, renewal date, storage quota) is at the bottom of
`0005_ensemble_core.sql` under "Owner workflow queries". These fields are
locked against browser edits on purpose — the SQL editor (and later
Stripe) is the only way a plan is granted.

**Extending a trial:** same "Owner workflow queries" block at the bottom
of `0005_ensemble_core.sql` — one `update` sets a new `trial_ends_at`.
Expired trials go read-only; nothing is ever deleted.

## Trials and grace periods expire by themselves now

You no longer have to remember to press "Run sweep". An hourly database job
(`cadence-subscription-sweep`, at :17 past every hour) moves workspaces whose
time is up into read-only:

- a trial past `trial_ends_at`,
- a workspace past `grace_ends_at` in `grace_period`,
- **and** a workspace left `past_due` by a failed card once its 14-day grace
  window closes — that last one never used to happen at all, so a workspace
  whose payment failed stayed fully writable indefinitely.

Read-only means exactly what it always meant: nothing is deleted, everything
stays readable, and writing resumes the moment a plan is active again. The
button on `admin-platform.html` still works and now runs the same code.

To check the job is alive: Supabase → SQL Editor →
`select * from cron.job_run_details order by start_time desc limit 5;`

## Switching card billing on (test mode first)

Both edge functions are **already deployed** to your project and are safe as
they stand: `stripe-checkout` answers `503 billing_not_configured` while
`STRIPE_SECRET_KEY` is unset, and `stripe-webhook` rejects any request whose
Stripe signature does not verify — there is no fallback path around the
signature. So nothing can be charged and nothing can be granted today.

One thing changed underneath you, and you should know about it: the
`stripe-webhook` function that had been sitting on the project since August
6th was from an older generation of Cadence. It fulfilled "Cadence Plus"
entitlements (a product with zero subscribers), and — more importantly — if
signature verification failed it *fell back* to re-fetching the event from
Stripe by id and processing it anyway, which is precisely the replay
protection a signature exists to provide. It has been replaced by the
version in this repository, which verifies or refuses, full stop, and records
every event id so a redelivery is a no-op. The previous source is preserved
in `docs/decisions/` if it ever needs to come back.

The remaining steps need **your** Stripe account, which is why no agent did
them for you: the price IDs only mean something inside the account whose
secret key you paste, so they cannot be created ahead of time on your behalf.

1. **Stripe dashboard → make sure the Test mode toggle is ON.** Everything
   below happens in test mode. No real card is ever charged in test mode.
2. **Products → Add product**, three times, each a *recurring, yearly* price:
   - `Cadence Ensemble` — $149.00 / year
   - `Cadence Ensemble Pro` — $299.00 / year
   - `Cadence Program` — $499.00 / year
   (These match `docs/ensemble/core.js` → `PLANS`. If you change a price,
   change it in both places or the site will advertise the wrong number.)
   Copy each price's `price_…` id.
3. **Developers → Webhooks → Add endpoint**, pointing at
   `https://srpqgbkodcrroobuksty.supabase.co/functions/v1/stripe-webhook`,
   subscribed to exactly these events: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`,
   `invoice.payment_failed`. Copy the endpoint's signing secret (`whsec_…`).
4. **Supabase → Edge Functions → Secrets**, set these six. They live only on
   the server; none of them ever belongs in the repository or a web page:

   | Secret | Value |
   |---|---|
   | `STRIPE_SECRET_KEY` | your **test** key, `sk_test_…` |
   | `STRIPE_WEBHOOK_SECRET` | the `whsec_…` from step 3 |
   | `STRIPE_PRICE_ENSEMBLE` | the $149 price id |
   | `STRIPE_PRICE_PRO` | the $299 price id |
   | `STRIPE_PRICE_PROGRAM` | the $499 price id |
   | `SITE_URL` | `https://cadenceperformingarts.github.io/Cadence-Labs` |

   A `STRIPE_WEBHOOK_SECRET` left over from an older Cadence generation is
   already set on the project — replace it with the one from step 3, or the
   webhook will reject your real deliveries.
5. **Test it end to end** with Stripe's test card `4242 4242 4242 4242`, any
   future expiry, any CVC. Buy a plan from a trial workspace's billing page.
   Then confirm the grant actually came from the database, not the browser:
   the workspace's plan changed, `select * from public.stripe_events;` has
   the event id, and `platform_audit_log` has a `stripe.*` row.
6. **Only after that**, and only when you decide to, repeat steps 1-4 with
   live-mode values. Nothing in this repository can do that for you, and
   nothing should until the legal documents have had a real review.

## If scores stop updating

The pipeline is three workflows in the repository's **Actions** tab on
GitHub (github.com → the repo → Actions):

- **Data update** — the main scrape. Scheduled every 15 minutes (GitHub
  often delivers that late; real gaps stay near half an hour).
- **Pulse** — a heartbeat that dispatches Data update every ~12 minutes
  in long shifts, because GitHub's own timer is unreliable. It restarts
  itself; Data update also restarts it if it dies.
- **Show-night live watcher** — summer show nights only: polls every ~3
  minutes so scores publish the moment they appear.

When scores look stale:

1. Open **Actions → Data update**. Green runs every ~15 minutes is normal.
2. If runs are red, open the newest one and read the log — a source being
   down usually fixes itself, and a failed scrape never erases good data.
3. To force a run: **Data update → Run workflow → branch `main` → Run**.
   The same button exists on Pulse and the watcher if they show no
   in-progress run.
4. If Data update is green but the site is stale, check **Deploy site** —
   every successful data run asks it to republish.

## Custom domain later

No domain has been purchased and none should be until you decide to. When
the site moves to its own domain, these must change together or logins,
notifications and share links quietly break:

- **Supabase auth redirects:** Supabase → Authentication → URL
  Configuration — set the new Site URL and add the new domain to the
  redirect allow-list (sign-in emails link back to the site).
- **Push relay:** set `SITE_URL` on the Railway service to the new domain
  (it defaults to the GitHub Pages address).
- **PWA manifests** (the files that make the site installable): their
  `start_url` is relative today, so they follow the domain automatically —
  but verify installs still work, and know that already-installed apps on
  phones stay pinned to the old address until reinstalled.
- **Hard-coded site URLs in pages** — share cards (`docs/wrapped.js`) and
  each family app's generated `siteUrl` — a developer/agent change.
- **Stripe return URLs** — once billing is live, checkout success/cancel
  and billing-portal return addresses must point at the new domain.

## Before charging real organizations

The honest launch checklist. Billing is **not live today** — no card can
be charged — and each line below must be true before that changes:

1. **Migrations applied to production** — done through 0018, and the
   security suite passes 64 checks against a scratch database.
2. **Storage policies confirmed** (section above) so workspace files are
   actually private. — done.
3. **Legal documents reviewed.** Drafts now exist at `docs/legal/`
   (terms, privacy, youth safety, data practices) — every one carries a
   DRAFT banner and none is in effect. Have a real person with legal
   knowledge review them before money changes hands; that review is a
   hard requirement, not a formality. (`docs/privacy-checklist.md` is an
   older internal note that predates the accounts system.)
4. **A monitored contact address.** Customers must be able to reach you.
   Today the only address in the system is the Web Push contact
   (`lucasbesel41@gmail.com`); decide what support address you will
   actually watch and publish it on the site.
5. **Stripe live keys server-side only.** The checkout and webhook code is
   built, tested against signed fixtures, and deployed — see "Switching card
   billing on" above. Test mode must work end to end before live keys are
   created, and live keys go in server environments (Supabase edge-function
   secrets / Railway variables) — never in the repository or a web page.
6. **Lock down the powerful accounts.** Turn on multi-factor
   authentication for your GitHub account and your Supabase dashboard
   login, and for the platform-admin account once that surface exists —
   these accounts can do everything the security migrations prevent
   everyone else from doing.

---

*Deeper references: `supabase/README.md` (database), `docs/ensemble/SETUP.md`
(workspace activation), `push-server/README.md` (relay deployment),
`docs/decisions/` (why things are the way they are — start with the latest
session report).*


## Site and database are in step

Both halves shipped together on 2026-08-18: migrations 0012-0017 are applied
to the live database, and the matching front-end was merged to `main` and
deployed. The workspace UI changes roles through the guarded
`set_member_role()` RPC that migration 0012 requires, so the two generations
match.

If you ever apply a migration *without* deploying the site (or vice versa),
re-read this section: the coupling that matters is the role editor, member
forms, event chat and the platform admin page — all four need both halves.
