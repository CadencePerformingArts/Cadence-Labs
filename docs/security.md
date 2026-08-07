# Security

Practical security posture for a small project with one owner, one primary AI
agent, and (eventually) real user accounts.

## Repository visibility

The repository serves GitHub Pages, so its contents are effectively public
today. Tradeoffs:

- **Public-ish (current):** free Pages hosting, easy sharing, community trust
  for an unofficial fan project. Cost: scraper logic and site internals are
  visible; nothing secret may ever live in the repo.
- **Private (possible later):** hides internals, but Pages on private repos
  requires a paid plan, and it changes nothing about real security — secrets
  don't belong in git either way.

Decision: stay public-ish; treat the repo as public in every habit. No secrets,
no user data, no credentials in code, config, fixtures, or commit history —
ever.

## Branch protection

Target settings for `main` (tightened as we exit the bootstrap phase — see
docs/ai-automation.md):

- PRs required; direct pushes blocked (exception: the scheduled scraper's data
  commits, limited to `docs/data/` paths).
- Required checks: typecheck, tests, web export.
- No force pushes, no branch deletion, linear history preferred.
- Owner approval required on PRs once L2 is strict again.

## Secrets

- All secrets live in **GitHub environment secrets** (and later Supabase/EAS
  secret stores), scoped per environment: `development`, `staging`,
  `production`.
- **Agents get dev/staging credentials only.** Production secrets are attached
  only to protected deploy environments that require owner approval to run.
- The **Supabase service-role key is server-side only** — GitHub Actions and
  server functions, never the app bundle, never an agent context, never logs.
  The app ships only the anon key, which is safe because of RLS.
- Rotate any secret that ever appears in a log or PR, immediately.

## Row Level Security (RLS)

When Supabase goes live:

- Competition data tables: public read, write restricted to the ingestion role.
- User tables (`profiles`, `favorites`, `notification_prefs`, `entitlements`):
  RLS policies so each authenticated user can read/write only their own rows.
- `audit_log`: append-only; no client write access.
- RLS policies live in `supabase/` migrations and are code-reviewed like any
  other change.

## Dependency risk

- Dependencies pinned via `package-lock.json`; updates arrive as PRs with CI.
- Prefer few, well-known packages; be suspicious of tiny packages with big
  permissions (postinstall scripts especially).
- Enable GitHub Dependabot alerts; treat a vulnerable-dependency alert like a
  failing check.
- The Python scraper's `requirements.txt` gets the same treatment.

## Audit

Everything flows through git: every change is a commit on a PR with CI logs,
agent work is identifiable by `agent/*` branches, and scheduled jobs log in
Actions. The PR history *is* the audit trail; nothing bypasses it except the
declared scraper data commits. Once Supabase exists, privileged actions also
write to `audit_log`.

## Backups

- **Code and config:** git is the backup (GitHub + any local clone).
- **Data today:** the scraper's raw page cache (`data/raw/`) and parsed JSON
  are committed, so history is recoverable by rerunning the pipeline.
- **Supabase later:** automatic daily backups on the platform; before beta,
  add a scheduled Actions job exporting logical dumps to separate storage, and
  actually rehearse a restore once.

## Related documents

- Threats and mitigations: `docs/threat-model.md`
- Agent rules: `docs/ai-automation.md`
- User data handling: `docs/privacy-checklist.md`
