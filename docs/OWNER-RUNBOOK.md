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
   after any migration change; the expected result is all checks passing (59 as of migration 0015).

## Storage policies — one-time step

Migration `0008` creates the private `ensemble` file-storage bucket. On
some Supabase projects the SQL editor is not allowed to set the bucket's
access policies and prints a notice like *"must be owner of table
objects"*. If you saw that notice (and only then), do this once by hand:

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

1. In Railway, open the relay service → **Variables**, and add:
   - `SUPABASE_URL` — your project URL (Supabase → Settings → API).
   - `SUPABASE_SERVICE_ROLE_KEY` — the service-role key from the same
     page. **Server-side only. Never put this key in the repository, a
     web page, or anywhere a browser can see it.**
2. That's it. The relay checks the queue every 30 seconds (tunable with
   `NOTIFY_POLL_SECONDS`). Without those two variables it does nothing
   new, so the existing score-push service is unaffected.

**What flows immediately:** in-app notifications (rows the workspace reads
when a member opens it). **What needs more work:** real push and email
delivery — those providers are deliberately stubbed as "unconfigured" and
skipped cleanly until a developer wires them. No message is sent until then.

## The platform admin screen (and the SQL fallbacks)

Once migration `0015` is applied, open
**https://cadenceperformingarts.github.io/Cadence-Labs/admin-platform.html**,
sign in with your owner account, and you can do all of this with buttons:
review claims, activate plans, extend trials, issue and mark invoices paid
(marking paid activates the plan automatically), run the subscription
sweep, and watch platform health. One-time setup: in the Supabase SQL
editor run
`update public.profiles set role = 'platform_admin' where id = (select id from auth.users where email = 'YOUR-EMAIL');`
— that row is the only thing that grants the page any power, and members
cannot grant it to themselves. Turn on MFA for that account
(Supabase → Authentication) before real money is involved.

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

1. **Migrations applied to production** through 0014, after a backup —
   0012 (security) especially. Security suite run by a developer/agent
   against a scratch database (59 checks as of migration 0015).
2. **Storage policies confirmed** (section above) so workspace files are
   actually private.
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
   not built yet (it is the next scoped priority). When it lands, live
   keys go in server environments (Supabase edge-function secrets /
   Railway variables) — never in the repository or a web page.
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
