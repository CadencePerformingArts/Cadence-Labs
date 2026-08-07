# Cadence push relay

A tiny Node service that watches the published Cadence data and sends a Web
Push to every subscriber the moment new DCI scores land. Subscribers with
★ favorites get their corps' scores in the notification itself.

## Deploy on Railway (~3 minutes)

1. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → pick `LukeBesel/DCI-Tracker`.
2. In the service settings, set **Root Directory** to `push-server`. Railway detects Node and runs `npm start` automatically.
3. (Recommended) **Settings → Volumes → Add volume**, mount path anywhere (e.g. `/data`) — this keeps the VAPID keys and subscriber list across redeploys. Without a volume, set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` env vars once (the values are printed by the first boot log) so keys never rotate.
4. **Settings → Networking → Generate Domain.** The app expects
   `https://cadence-push-production.up.railway.app` — either name the domain
   that, or update `PUSH_SERVER` at the top of the push block in
   `docs/index.html` to whatever URL Railway gives you.

That's it. `GET /` shows a status JSON (subscriber count, last check, pushes sent).

## Environment (all optional)

| var | default | purpose |
| --- | --- | --- |
| `SITE_URL` | `https://lukebesel.github.io/DCI-Tracker/` | site to watch |
| `POLL_SECONDS` | `120` | how often to check for new scores |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | auto-generated | pin push identity |
| `VAPID_SUBJECT` | `mailto:lucasbesel41@gmail.com` | Web Push contact |

## API

- `GET /` — redirects to the Cadence app (humans land somewhere useful)
- `GET /status` — status JSON (subscriber count, last check, pushes sent)
- `GET /vapid` — public key for the browser's `pushManager.subscribe`
- `POST /subscribe` — `{subscription, favs: ["Bluecoats", …]}`
- `POST /unsubscribe` — `{endpoint}`
- `POST /test` — `{endpoint}` sends a test notification to that subscriber
