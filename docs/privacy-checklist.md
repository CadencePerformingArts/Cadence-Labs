# Privacy Checklist

What Cadence collects, what it will collect, and what has to be true before
launch. Guiding rule: collect the minimum, label everything, make deletion
easy.

## Data collected today

**Server-side: none.** There are no accounts, no analytics SDKs, no tracking,
and no backend of ours receiving user data.

**On-device only:**
- Favorites (which ensembles/events you follow).
- Preferences (mode, theme, notification settings placeholders).

These live in local storage on the device/browser (`packages/data`
`favorites.ts` / `prefs.ts` / `storage.ts`) and never leave it. Deleting the
app (or clearing site data on web) deletes them.

Note: GitHub Pages serves the site, and GitHub's own standard server logs
apply to any web visit; we add nothing on top.

## Data collected in the future (when accounts ship)

- **Account email** — for sign-in (email OTP) and, via Sign in with Apple /
  Google, the identity token. Apple's private relay emails must be supported.
- **Push tokens** — device tokens for score notifications.
- **Synced favorites and notification preferences** — the on-device data above,
  moved to Supabase rows owned by the user (RLS-protected).
- **Entitlement status** — free vs Cadence+, mirrored from RevenueCat.
- Explicitly **not** collected: location, contacts, ad identifiers, cross-app
  tracking, analytics tied to identity (any analytics adopted must be
  aggregate/anonymous and re-reviewed here).

## Deletion

Required before accounts launch:

- **In-app account deletion** — a real button that deletes the auth user and
  all owned rows (profiles, favorites, notification_prefs, entitlements
  mirror), not a mailto link. Apple requires in-app deletion for apps with
  accounts.
- **Web request path** — a documented email/form for deletion requests from
  people who can't access the app, honored within 30 days.
- Push tokens invalidated on deletion; RevenueCat subscriber data deleted via
  their API as part of the flow.

## Policy hosting — TODO

- Write a plain-English privacy policy (what's collected, why, retention,
  deletion, contact).
- Host it at a stable public URL (the GitHub Pages site is fine:
  `/privacy`), linked from the app's More tab and both store listings.
- Both stores require this URL at submission; it must exist before the first
  TestFlight external build.

## Store privacy questionnaires

- **Apple "App Privacy" (nutrition label):** today — "Data Not Collected".
  After accounts: Email (account management), Identifiers/push token
  (app functionality), Purchases (entitlement). Nothing "used to track you".
- **Google Play Data safety:** mirror the same answers; declare encryption in
  transit and the deletion path.
- Re-answer both questionnaires whenever this checklist changes; the checklist
  is the source of truth, the store forms are copies of it.

## Ongoing rules

- New SDKs get a privacy review before merging (what do they phone home?).
- No user data in logs, error reports, or fixtures.
- Children: the app is general-audience; we do not target children and collect
  nothing beyond the above regardless of age.
- This checklist is reviewed at each release (docs/release-checklist.md) and
  whenever data handling changes.
