# Session report — security, functional fixes, notification spine

Branch: `claude/github-ai-coding-setup-gk88x9`. Nothing was deployed, merged
to `main`, or applied to production. All work is on the feature branch with
a clean rollback path (additive migrations only). Owner deployment steps are
in section 11.

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
