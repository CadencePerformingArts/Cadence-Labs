# Store Readiness

What stands between today's Expo Go/web app and listings on the App Store and
Play Store. Tracks state honestly: much of this is prepared-but-blocked on
owner accounts.

## EAS build profiles (plan)

`eas.json` will define three profiles:

- **development** — dev client, internal distribution, connects to
  dev/staging data. For day-to-day device testing beyond Expo Go.
- **preview** — release-mode binary, internal distribution (TestFlight
  internal / Play internal testing). What the owner and testers install.
- **production** — store-submission builds, auto-incremented build numbers,
  production environment config. Used only via the release checklist.

EAS Submit will handle upload to both stores once accounts exist.

## Identifiers

- iOS bundle identifier: `com.cadencelabs.cadence` (placeholder set in app
  config).
- Android package: `com.cadencelabs.cadence`.
- These become permanent at first store submission — confirm before the first
  production build, not after.

## Icons and splash — TODO

Template Expo icons and splash are still in place. Needed before any store
submission:

- App icon (1024×1024 master; navy/gold mark, no text).
- Android adaptive icon (foreground + background layers).
- Splash screen for light and dark.
- Favicon/web icons for the Pages deploy.

## Permission strings

Keep the permission footprint minimal; every string must say why in plain
English:

- **Push notifications** (the only planned permission at launch): "Cadence
  alerts you when scores post for the ensembles you follow."
- No location, camera, microphone, contacts, or tracking. If that changes, this
  doc and the privacy checklist change first.
- App Tracking Transparency: not needed (no cross-app tracking, no ad SDKs).

## Metadata draft (outline)

- **Name:** Cadence — Scores & Standings
- **Subtitle/short description:** Year-round scoreboard for drum corps, guard,
  band, a cappella, and show choir.
- **Description:** lead with the five modes and real DCI history back to 1972;
  be explicit that it's an unofficial fan app and which modes currently show
  demo data.
- **Keywords:** DCI, drum corps, WGI, color guard, marching band, BOA, ICCA,
  a cappella, show choir, scores.
- **Screenshots:** 3 modes minimum (DCI scoreboard with real data, WGI classes,
  an event recap), light and dark, phone + tablet sizes.
- **Category:** Sports (both stores).

## Review notes template

Include with every store submission:

> Cadence is an unofficial fan scoreboard for competitive marching and vocal
> arts. No login is required to browse. DCI shows real historical/season data
> from public sources (credited in-app); other modes display clearly labeled
> demo data ("DEMO DATA" badge) until live sources launch. Test account: none
> needed (or credentials here once accounts ship). Subscriptions are managed
> via RevenueCat; use sandbox tester [details] to verify purchase and restore.

## Blocked on owner accounts

Cannot proceed until the owner creates and pays for:

- **Apple Developer Program** ($99/yr): bundle ID registration, TestFlight,
  push certificates/keys, any iOS distribution.
- **Google Play Console** ($25 once): package registration, internal testing
  track, Play billing.
- Store banking/tax/agreement steps for paid features (see monetization.md).

Everything else — profiles, config, metadata drafts, icon specs, review notes,
privacy questionnaire answers (docs/privacy-checklist.md) — can be prepared in
the repo ahead of time so account creation is the only remaining gate.
