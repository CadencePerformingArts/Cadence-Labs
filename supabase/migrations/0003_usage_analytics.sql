-- Cadence usage analytics — self-owned, privacy-light.
-- Apps insert anonymous screen-view events; nothing is readable by clients.
-- Owner reads via the SQL editor / service role. No IPs, no fingerprints:
-- a per-tab session id, the app, the screen, coarse device class.
--
-- ─── Owner: run this file once in the Supabase SQL editor. ───
--
-- Example questions it answers (run in SQL editor):
--   Top screens per app, last 30 days:
--     select app, screen, count(*) views
--       from usage_events where ts > now() - interval '30 days'
--      group by 1,2 order by views desc limit 40;
--   Daily active sessions:
--     select date_trunc('day', ts) d, count(distinct session_id) sessions
--       from usage_events group by 1 order by 1 desc limit 30;
--   Signed-in share:
--     select count(distinct session_id) filter (where user_id is not null)::float
--            / nullif(count(distinct session_id), 0) signed_in_share
--       from usage_events where ts > now() - interval '7 days';

create table public.usage_events (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  session_id uuid not null,
  user_id uuid,                    -- set when signed in; never required
  app text not null,               -- 'dci' | 'boa' | 'wgasc' | 'plus' | 'modes' | …
  screen text not null,            -- 'scoreboard' | 'events' | 'corps-detail' | …
  event text not null default 'view',
  detail text,
  device text,                     -- 'mobile' | 'desktop'
  standalone boolean,              -- installed as a PWA?
  ref text                         -- referrer host on the session's first event
);

alter table public.usage_events enable row level security;

-- clients may only append; nobody but the service role can read
create policy "append usage" on public.usage_events
  for insert to anon, authenticated with check (true);

create index usage_events_ts_idx on public.usage_events (ts);
create index usage_events_app_screen_idx on public.usage_events (app, screen);
create index usage_events_session_idx on public.usage_events (session_id);
