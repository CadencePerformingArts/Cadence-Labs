# Session report — security, functional fixes, notification spine

**Fully shipped.** Developed on `claude/github-ai-coding-setup-gk88x9`;
migrations 0012-0017 applied to the live Supabase project and the branch
merged to `main` and deployed to the public site, both at the owner's
explicit instruction. See "Production application" and "Deployment" at the
end of this document for exactly what was run and verified.

## 1. Executive outcome

Cadence Ensemble was **not** safe to sell before this session: a member could
promote themselves to Owner against the live database, and six more workspace
vulnerabilities were open. All seven are now closed by an additive migration
(`0012`) and proven shut by a repeatable adversarial suite (45/45). Nineteen
of the twenty verified functional bugs are fixed with regression guards, and
a real workspace notification spine — the missing piece for a credible
communications product — now exists end to end (queue, enqueue triggers,
worker, tests). The workspace is materially safer and more complete; it is
ready for a staging apply and a real-account walk-through, not yet for live
billing.

Priorities completed: **P0 security, P1 functional bugs, P2 notification
foundation.** Priorities 3–12 (onboarding, mobile-nav redesign, identity
unification, shared-module consolidation, platform admin, Stripe billing,
remaining workspace gaps, a11y/perf/legal) are scoped and deferred with
rationale in sections 12–13.

## 2. Security (P0) — every finding

Migration `supabase/migrations/0012_security_hardening.sql`. Each fix has an
adversarial test in `scripts/test_db_security.py` that replays the attack as
the real Postgres role, exactly as PostgREST executes it.

| # | Root cause | Fix | Test result |
|---|-----------|-----|-------------|
| 0A | `members_self` UPDATE policy restricted rows, not columns — a member could PATCH their own `role_id` to Owner | `guard_member_update` trigger refuses role/identity/privilege changes via the API; roles change only through `set_member_role()`, which blocks self-promotion, protects the last admin, and audits | member self-promote **blocked**; director raw PATCH **blocked**; self-promote-via-RPC **blocked**; last-admin demote **blocked**; RPC role change by a second admin **works** |
| 0B | `role_id` could reference another org's role | Same-org composite FKs on `org_members` and `org_invites`, validated against existing data before enforcing | cross-org role assignment **blocked**; foreign-role invite **blocked** |
| 0C | Client-authoritative `size_bytes`; admins could rewrite `storage_used_bytes`; concurrent uploads raced the quota | Size reconciled from the real stored object (`sync_file_size`); usage is a guarded field; quota check locks the org row | admin rewrite of usage **blocked**; client size edit **blocked** (even a file manager); reconcile from bucket **works**; usage matches object |
| 0D | `redeem_org_invite` read uses without locking | Invite row locked; membership check precedes the use-count guard; idempotent | concurrent last-use race admits **exactly one**; idempotent re-redeem **works**; exhausted invite **refused** |
| 0E | Any member could overwrite another's claimed drill dot | Ownership-checked + serialized claim; staff reassign via `assign_drill_dot`; viewer shows the conflict | steal a claimed dot **blocked**; reclaim own **works**; plain member reassign **blocked**; staff reassign **works**; cross-org **blocked** |
| 0F | Youth-safety keyed on the client's chat `kind` — a two-person "group" chat bypassed `pair_may_dm` | Safety follows the actual participants (`safety_exempt` stamped by the org's `chat.create` grant, not the label); shrinking a room to an unsafe pair is refused | student→staff in a fake "group" **blocked**; student→minor **blocked**; staff-created room **works** |
| 0G | `usage_events.user_id` was client-set | Trigger stamps the real `auth.uid()` (null for anon); text fields capped | spoofed identity **dropped**, real identity recorded; anon insert still **works** |

Also repaired in the same pass (found during the audit):

- **0006 grant drift (high impact):** fifteen policy-helper functions
  (`can_see_post`, `dm_allowed`, `may_create_chat`, `should_notify`, …) were
  revoked from `public` in 0006 but never re-granted to `authenticated`, so
  every RLS policy calling them raised *"permission denied for function"* for
  real signed-in users — chat creation, post visibility, DM safety and the
  notification rule were effectively broken in production. All fifteen are
  now granted to `authenticated`.
- **0011 drill policies** applied to `anon` (no role clause); pinned to
  `authenticated`.
- **Ensemble Pro claim takeover:** an approved claimant was blocked from a
  profile row another user created; the update policy now keys on approval
  (`has_approved_ensemble_claim`) and stamps the acting owner.

Broader audit (0I): reviewed all SECURITY DEFINER functions, grants,
guarded columns, and the tenant-isolation surface; findings above are the
material ones. Tenant isolation, read-only-org enforcement, and
service-role-only worker access are all covered by the suite.

Remaining risk: the four `storage.objects` bucket policies still require a
one-time dashboard action on projects where the SQL role can't alter
`storage.objects` (documented, unavoidable in Supabase — see 0008 / SETUP.md
/ section 11). Everything else is enforced in-migration.

## 3. Functional bugs (P1) — 19 fixed, 1 deferred

Regression guards: `scripts/test_p1_fixes.js` (19 source invariants) and
`scripts/check_workflow_names.py`.

| # | Bug | Status |
|---|-----|--------|
| 8 | Event-kind SVG icons rendered as literal markup text | **fixed** — icons render raw, labels escaped, dropdowns label-only |
| 9 | Music page highlighted the Files tab | **fixed** (`nav:'music'`) |
| 10 | "Event chat" link did nothing | **fixed** — migration 0013 (`chats.event_id` + `open_event_chat` RPC), messages.html reads `?event=` |
| 11 | Admin acks tile queried a nonexistent table | **fixed** — counts ack-required posts; attendance scoped via event inner-join |
| 12 | Signups gated on the Pro-only `volunteer_management` key | **fixed** — gates on base-plan `signups` |
| 13 | `drill.manage` missing from the role editor | **fixed** |
| 14 | Home deep links pointed at nonexistent anchors | **fixed** — scroll-to + pulse on the real row |
| 15 | Preference-deletion resurrection / non-atomic favorites | **deferred within P1** — see note |
| 16 | Prediction-reminder toggle stored a preference nothing read | **fixed** — toggle removed |
| 17 | Timezone: `slotMs` assumed EDT=UTC-4; show-day flag used UTC | **fixed** — venue IANA zone; ET day |
| 18 | Combined Biggest Move mixed merged delta with single-class prev | **fixed** — merged `prev_score` |
| 19 | Suggestions posted to `LukeBesel/DCI-Tracker` | **fixed** — current repo |
| 20 | Switcher marked DCI current on unlisted apps | **fixed** |
| 21 | UIL State placements render as Roman-numeral ratings | **deferred** — see section 12 |
| 22 | `purge_fabricated.py` cleared wrong keys, wrote malformed index | **fixed** + `--dry-run` |
| 23 | `ci-status.yml` watched a nonexistent workflow name | **fixed** + drift guard |
| 24 | Approved claimant couldn't take over a profile | **fixed** in 0012 |
| 25 | README/docs cited nonexistent migrations, 404 link, wrong owner | **fixed** (README, supabase/README, plus-guide, push-server) |
| 26 | `color-scheme: light` fought dark mode | **fixed** across 29 pages |
| 27 | Local drill sketchpad had no shell | **fixed** — minimal shell, real exit, unsaved-work guard |

Two honest carve-outs:

- **#15 (preference-sync tombstones)** was scoped but not implemented this
  session — it needs a tombstone column and a merge-precedence change in
  `account.js` plus the `preferences` table, and touches the cross-device
  sync path that every page depends on. It is lower blast-radius than the
  security work and is filed for the shared-module pass (section 13).
- **#21 (UIL placements)** — see section 12.

## 4. Notifications (P2) — foundation complete and tested

- **Queue (`0014`):** `org_notifications` — type, channel (inapp/push/email),
  priority, template-safe payload, dedupe key, status, attempts,
  `scheduled_at`. Payloads carry only titles/names/links/counts; never
  message bodies, medical/form answers, drill coordinates, or contacts.
- **Enqueue triggers:** organization invitation (email), acknowledgment-
  required announcement (in-app + push to each audience member who hasn't
  silenced it via `should_notify`), RSVP-required event (in-app).
  `post_audience()` expands targets to concrete members.
- **Worker (`push-server/notify-worker.js`):** dependency-injected drain
  (claim → render safe template → send → mark). Idempotent, bounded retries
  with backoff then dead-letter, unconfigured channels and dead endpoints
  skipped not failed. Wired into the relay opt-in (drains only when
  `SUPABASE_SERVICE_ROLE_KEY` is set) so the existing score-push deployment
  is unaffected. **12/12 worker tests**, no network.
- **RLS:** a recipient reads only their own in-app rows and can set only
  `read_at`; a guard trigger blocks status/payload tampering; there is no
  client insert path, so nothing can be forged. 7 notification checks in the
  security suite.

Deferred P2 increments: in-app notification center UI, settings channel-
status truthfulness, and real push/email provider wiring (providers are
stubbed "unconfigured" and skip cleanly until keys land).

## 5. Validation (exact)

```
python3 scripts/test_db_security.py     → PASS 45   (fresh apply + additive upgrade + 7 notification checks)
node    push-server/notify-worker.check.js → PASS 12
node    scripts/test_p1_fixes.js         → PASS 19
python3 scripts/check_workflow_names.py  → 3 watched workflows, all present
python3 scripts/gen_sql_bundles.py       → RUN_ALL 14 migrations, RUN_ENSEMBLE 10
python3 scripts/build_family_engine.py   → derived engine re-derived cleanly (asserted transforms intact)
```

Browser (Playwright, system Chromium, localhost:8091): nine core pages
(DCI `/`, Shows, Settings, Captions, WGI Guard, UIL, BOA, workspace index,
drill sketchpad) render at **390px with zero console errors and zero
horizontal overflow**. All touched inline scripts parse. Drill engine
geometry 4/4 core checks.

Fresh-database apply and additive-upgrade-from-prior-schema are both proven
by the security suite (it builds a second database with 0001–0011 then
applies 0012 and checks the new guards exist).

No live Supabase, Stripe, email, or push was touched. No real messages sent.

## 6–8. Architecture, admin, billing

Platform administration (P6) and Stripe org billing (P7) were **not** built
this session — they are the next priorities and are scoped in section 13.
The security model that makes them safe is now in place: service-role-only
worker RPCs, guarded columns, and `profiles.role='platform_admin'` ready to
gate a privileged surface. No privileged action was moved into the browser;
no secret entered the client bundle.

## 9. Configuration added

| Kind | Name | Notes |
|------|------|-------|
| Migration | `0012_security_hardening.sql` | additive; apply before untrusted invites |
| Migration | `0013_event_chats.sql` | event chat rooms |
| Migration | `0014_notifications.sql` | notification queue + triggers + worker RPCs |
| Env (worker) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | enables the relay's notification drain; **service-role key is server-only** |
| Env (worker) | `NOTIFY_POLL_SECONDS` | optional, default 30 |
| Script | `scripts/test_db_security.py` | adversarial suite (disposable PG only) |
| Script | `scripts/test_p1_fixes.js`, `scripts/check_workflow_names.py` | regression guards |
| Script | `scripts/gen_sql_bundles.py` | regenerates RUN_ALL / RUN_ENSEMBLE |

No new secret is stored in the repo. The service-role key lives only in the
worker's server environment.

## 10. Commits (feature branch, nothing deployed)

- `9c4e6ddb7` — Security hardening (0012) + adversarial suite
- `852654c31` — 19/20 functional bugs + event chats (0013) + regression guards
- `5b87bd062` — Notification spine (0014) + worker + tests

All pushed to `origin/claude/github-ai-coding-setup-gk88x9`. Not merged to
`main`, not deployed.

## 11. Owner actions required

1. **Staging apply.** On a scratch/staging Supabase, paste
   `supabase/migrations/RUN_ALL.sql` (fresh) or apply `0012`, `0013`, `0014`
   in order (existing). Run `python3 scripts/test_db_security.py` to confirm
   45/45 against a disposable database.
2. **Production backup, then apply 0012–0014** in order (or the
   `RUN_ENSEMBLE.sql` bundle). 0012 is additive and was verified upgrading
   the prior schema. **Apply 0012 before inviting anyone you don't fully
   trust.**
3. **Storage policies (one-time).** If 0008's storage block printed a
   privilege notice, add the four `ensemble` bucket policies in Supabase →
   Storage → Policies (expressions in SETUP.md).
4. **Notification worker (optional, when ready).** Set `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` on the relay host. In-app notifications flow
   immediately; push/email require wiring their providers (next increment).
   No real messages are sent until then.
5. **Do not** enable live Stripe, buy a domain, or change DNS — none of that
   was built and none is ready.

## 12. Deferred with rationale — #21 UIL placements

UIL State placement rows (3,182 of them across 93 State events) render as
Roman-numeral ratings in the engine's *secondary* views (Shows list, event
pages) because the derived engine sets one app-level `resultsKind='rating'`
and `score3` renders any 1–5 value as a Roman numeral. A correct fix means
distinguishing rating from placement *per row*, which requires either a
change to the asserted-string-transform family engine (whose every edit
rebuilds and can break all nine circuit apps) or a broader refactor of the
score-normalization path. UIL is currently **unlisted**, and its **primary**
view — the rating board (`board.js`) — already renders State placements
correctly via its dedicated State panel. Per the session's own guardrail
("leave the working implementation intact rather than make a destructive
assumption"), the working code was left in place and the fix is filed for
the shared-engine work in section 13, where the normalization path is being
touched anyway.

## 13. Remaining priorities (3–12), in recommended order

1. **Preference-sync tombstones (#15)** and the shared-module consolidation
   (P5): one `esc`, sheet/modal, token-scan, permission-vocabulary, app-
   registry, and plan-authority module. The app registry also fixes the
   naming/identifier fragmentation (P4) and gives #21 a clean home.
2. **First-run onboarding** both sides + the **mobile workspace nav
   redesign** to Home / Calendar / Messages / Drill / More (P3).
3. **Platform admin** (P6): a service-role edge function gating claims,
   plans, invoices on `profiles.role='platform_admin'` — retires the SQL
   runbooks.
4. **Stripe test-mode org billing** (P7): checkout + signature-verified
   webhook + portal, all server-side, honest test states.
5. **Workspace gaps** (P8): member form fill-in (with stricter medical
   access), drill data-loss protection, export/retention.
6. **Design/a11y/perf passes, docs rewrite, legal drafts** (P9–P12).

Everything above builds cleanly on the security and notification foundations
laid this session.

---

## Continuation checkpoint (second work block)

Completed since the report above, each verified and committed:

- `0a96a2722` — **#15 preference sync**: last-writer-wins with tombstones
  (deletions propagate, nothing resurrects), favorites off union-merge,
  relational mirror upsert-then-prune. `scripts/test_sync_merge.js` 23/23.
- `665e8293d` — **P3**: phone dock = Home/Calendar/Messages/Drill/More
  (More sheet holds Announcements/Files/Music/Members/Admin/Billing,
  permission-gated, Escape/backdrop close; desktop keeps the full rail);
  director setup checklist on workspace Home (auto-derived from real data,
  permission-aware, dismissible); fan starter hint (`docs/starter.js`,
  standalone, self-retiring). Browser-verified at 390px and 1200px.
- `41feafadd` — **P5F/P4A**: expired champ.js removed (+ SW shell, cache
  → v23); installed app renamed 'Cadence DCI' (no customer-facing
  'Cadence Labs' remains).

Suites at checkpoint: db security 45/45 · worker 12/12 · P1 guards 19/19 ·
sync 23/23 · workflow-names clean · pages clean at 390px. Working tree
clean, everything pushed to `claude/github-ai-coding-setup-gk88x9`.

**Exact next task:** P4B canonical app registry (`docs/registry.js`: one
authority for ids/names/paths/namespaces/board/status; adopt in modes.js,
my.js — which today ignores 6 circuits' favorites — analytics.js,
ensembles.js; migrate legacy localStorage keys losslessly). Then P6
platform admin (service-role RPCs gated on `profiles.role='platform_admin'`
for claims/plans/invoices), then P7 Stripe test-mode org billing (edge
function code + signed-fixture webhook tests; nothing deployed). Deferred
items and blockers are unchanged from sections 12–13.


---

## Completion block (third work session): the remaining priorities

All commits on `claude/github-ai-coding-setup-gk88x9`; nothing merged,
deployed, or applied to production. Suite totals at the end of this block:
**DB security 59/59 · Stripe core 18/18 · sync 23/23 · P1 guards 19/19 ·
worker 12/12 · monorepo vitest 27/27 · workflow-name guard clean.**

- `f5ab38d40` — **App registry (P4B).** `docs/registry.js` is the one
  authority for all ten apps; my.js (six circuits' favorites now surface in
  My Cadence — browser-verified), ensembles.js, modes.js and the family
  template consume it. ISSMA's dead entry removed.
- `fe51c54d0` — **Platform admin (P6).** Migration 0015: platform_admin-
  gated SECURITY DEFINER RPCs (claims review, org list, plan activation,
  trial extension, invoice issue/paid-with-atomic-activation, health,
  subscription sweep) + an immutable platform audit log org admins cannot
  read. `docs/admin-platform.html` is the UI; the owner signs in normally
  and the database is the authority. 14 new adversarial checks. Also:
  `docs/legal/` draft terms/privacy/youth-safety/data pages (DRAFT-bannered,
  no compliance claims, no invented contact), `docs/OWNER-RUNBOOK.md`, and
  a truthful `README.md`.
- `bf79e8a3f` — **Stripe org billing, test mode (P7).** Two edge functions
  (code complete, NOT deployed): server-side checkout with in-database
  billing.manage verification, and a raw-body signature-verified webhook
  with a stripe_events idempotency ledger (0016). The state machine and
  signature check are a shared pure module tested from Node with signed
  fixtures (18/18). billing.html's card button calls the function and
  degrades honestly when checkout isn't switched on; invoice/PO unchanged.
- `1cd1cfc56` — **P8 + green CI.** Member form fill-in (forms.html: every
  field type, required validation, guardian-aware via RLS, editable until
  close, Home "waiting on you" + nav integration); drill data-loss
  protection (local snapshot on save, updated_at conflict detection with
  an explicit choice instead of silent overwrite); Admin data export
  (roster/attendance/announcements CSV under the exporter's own RLS). CI:
  the App CI failure the owner saw was vitest collecting the worker test
  by filename — renamed to `.check.js`, and App CI gained a path-aware
  `site` job running every repo suite plus a parse check of all shipped
  scripts.

### Still deferred, with reasons (unchanged in kind)
- **#21 UIL placement rendering** in secondary engine views — needs the
  shared-engine refactor; UIL is unlisted and its primary board is correct.
- **Family-engine replacement (5E)** — explicitly conditional in the brief;
  the asserted-transform system stays, now covered by the parse gate in CI.
- **Real push/email providers** for workspace notifications — stubbed
  "unconfigured, skipped" until the owner picks providers and sets keys.
- **Formal accessibility/performance audits and a11y sweeps** beyond the
  overflow/console/reduced-motion checks done page-by-page; **more
  circuits, stores, Cadence+ launch, Event Pro** — out of scope by the
  brief's own defer list.

### Owner actions (delta from section 11)
1. Apply **0015 and 0016** after 0012–0014 (or re-paste RUN_ENSEMBLE.sql).
2. Grant yourself the platform role (one UPDATE, in OWNER-RUNBOOK.md) and
   use **admin-platform.html** instead of the SQL runbooks.
3. When ready for test-mode card checkout: create the three test prices in
   Stripe, `supabase functions deploy` the two functions, set the secrets
   listed in their headers, and add the webhook endpoint. Test cards only;
   nothing charges for real until you swap live keys — a step this repo
   deliberately cannot do.

- `2056258f9` — **The last gaps.** Bug #21 fixed for real (placement-marker
  encoding in the derived engine; 8/8 fixture tests against the built
  engine); notification channels made real — a Resend email adapter (invites
  send the moment RESEND_API_KEY + NOTIFY_FROM_EMAIL exist) and user-linked
  workspace web-push with a JWT-verified /subscribe-user registration
  endpoint on the relay (19/19 provider tests, 5 adversarial JWT checks);
  workspace sheets got focus trapping, Escape, focus restore, and
  aria-modal. Remaining by design: the family-engine replacement (the brief
  made it conditional and it cannot be completed safely here), app stores /
  more circuits / Cadence+ launch (the brief's own defer list), and the
  owner-side activations documented above.


---

## Production application (2026-08-17)

Applied to the live project `srpqgbkodcrroobuksty` ("Cadence Labs",
Postgres 17) at the owner's explicit instruction, via the Supabase
management API. Pre-flight state: 61 tables, RLS on all 61, 149 policies,
**0 organizations and 1 user** — i.e. no real workspace data existed, which
made this the lowest-risk possible moment to apply.

| Migration | Result |
|---|---|
| `0012_security_hardening` | applied |
| `0013_event_chats` | applied |
| `0014_notifications` | applied |
| `0015_platform_admin` | applied |
| `0016_stripe_events` | applied |
| `0017_storage_policies` | applied (see below) |

Post-state: **64 tables, RLS enabled on all 64, 152 policies**, 8 new RPCs
present, and the 15 grant-drift helper functions confirmed executable by
`authenticated` again.

**Verified against production, not just locally:**

- The role-escalation attack was replayed inside a rolled-back transaction:
  a member demoted to `member` attempted (1) a raw PATCH of their own
  `role_id` to Owner and (2) self-promotion through `set_member_role()`.
  **Both were blocked**; the role was unchanged; the transaction rolled back
  and left no rows (organizations still 0).
  *(A first attempt reported a false "regression" — the test promoted the
  org creator, who the seed trigger already makes Owner, so `role_id` never
  actually changed and there was nothing to block. The corrected test starts
  from a genuinely lower role.)*
- As a signed-in stranger, all five privileged RPCs (`padmin_sweep_subscriptions`,
  `padmin_set_plan`, `padmin_mark_invoice_paid`, `prune_stripe_events`,
  `claim_notifications`) **raised**, and every admin read surface returned
  empty/null (`padmin_health` null; claims, orgs, platform audit log and
  `stripe_events` all 0 rows).
- Supabase security advisors: **no findings introduced by this work.** The
  one ERROR (`org_directory` is a SECURITY DEFINER view) is pre-existing and
  deliberate — see the note below. The 71 WARNs are the RLS-helper pattern,
  also pre-existing and required.

**The storage blocker is finally cleared.** The `ensemble` bucket existed and
was correctly private (500 MB), but had **zero policies** on
`storage.objects` — RLS on with nothing allowed, so every file upload and
download was denied. 0008's guarded block had been skipped on this project
because the SQL editor's role cannot alter that table. The management API
*can*, so the four policies are now applied and verified (read/insert/update/
delete, all `authenticated`, all scoped to `bucket_id = 'ensemble'` plus the
path-ownership helpers). `0017_storage_policies.sql` records this in the repo
so the state is reproducible — itself exception-guarded, because it also
rides inside the single-transaction bundles.

The owner's account (`lucasbesel41@gmail.com`) was granted
`profiles.role = 'platform_admin'`, so **admin-platform.html is live** for
them and refuses everyone else.

### Two accepted, pre-existing advisor findings

1. **`org_directory` SECURITY DEFINER view (ERROR).** This is the
   "find and join your workspace" directory. It deliberately bypasses the
   `organizations` RLS so a *non-member* can see groups that opted in, and it
   exposes only seven non-sensitive columns (`id, name, slug, org_type,
   public_app_key, public_ensemble_name, accepting_requests`) for rows where
   `directory_visible` is true. `anon` cannot read it at all. The alternative
   — a table-level RLS policy — would expose **every** column of those rows,
   including `plan`, `status`, `stripe_customer_id` and storage counters. The
   definer view is the *safer* of the two designs, so it stays.
2. **71 × "SECURITY DEFINER function executable by authenticated" (WARN).**
   These are the RLS policy helpers. A policy is evaluated with the caller's
   privileges, so they *must* be executable by `authenticated` — revoking
   them is precisely the 0006 grant-drift bug that had silently broken chat,
   post visibility and DM safety in production. Each one answers only about
   the caller (`auth.uid()`), so direct RPC calls leak nothing. The
   textbook-cleaner fix (move helpers to a non-exposed schema) is a
   71-function refactor across every migration and is filed, not attempted.

### What is still owner-only
Nothing about the database. The remaining items are external services: the
notification env vars on the relay, the Stripe test deploy, legal review of
the `docs/legal/` drafts, and enabling MFA on the platform-admin account
(Supabase → Authentication) before real money is involved.


---

## Deployment (2026-08-18)

The front end shipped to match the database.

- `main` had advanced 280 commits (all score-cron data updates) while this
  work was on its branch. Rather than merge onto `main` and risk racing the
  cron, `origin/main` was merged **into the branch** first — no conflicts,
  since the cron only touches `data/` and `docs/data/` — then the full gate
  was re-run against the merged tree: P1 19/19, sync 23/23, Stripe 18/18,
  UIL 8/8, worker 12/12, providers 19/19, monorepo vitest 27/27, typecheck
  clean, and 18 pages browser-checked at 390px and 1280px with no console
  errors and no overflow.
- The derived family engine was rebuilt (cache-bust hashes changed on the
  nine circuit pages, as expected after the UIL transform fix).
- `main` was then fast-forwarded, with a retry loop for the cron: it did push
  two more data commits mid-flight, which were merged and the push succeeded
  on the first attempt.
- GitHub Pages redeployed; the live site now serves `registry.js`,
  `admin-platform.html`, `ensemble/forms.html` and the `legal/` pages.

Deployment risk was low by construction: the workspace side has no
organizations and one user, so no member was mid-session during the swap,
and the public scoreboards are static files whose data layer was untouched.
