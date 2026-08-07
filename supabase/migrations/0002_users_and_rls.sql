-- User-facing tables and Row Level Security.
--
-- Public competition data is world-readable. Everything keyed to a user is
-- protected by RLS so a user can only ever read or write their own rows.
-- The service role (server-side jobs only — never shipped in the app) bypasses
-- RLS for ingestion and admin work.

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table favorites (
  user_id uuid not null references auth.users (id) on delete cascade,
  mode_id text not null references modes (id),
  ensemble_id text not null references ensembles (id),
  created_at timestamptz not null default now(),
  primary key (user_id, mode_id, ensemble_id)
);

create table notification_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  scores_final boolean not null default true,
  favorites_only boolean not null default false,
  quiet_hours int4range,            -- local hours, e.g. [22,8)
  updated_at timestamptz not null default now()
);

create table push_tokens (
  user_id uuid not null references auth.users (id) on delete cascade,
  token text not null,
  platform text not null check (platform in ('ios', 'android', 'web')),
  created_at timestamptz not null default now(),
  primary key (user_id, token)
);

-- Entitlements mirror RevenueCat webhooks; the app treats this table as the
-- single truth for Cadence+ access.
create table entitlements (
  user_id uuid not null references auth.users (id) on delete cascade,
  entitlement text not null,        -- 'cadence_plus'
  active boolean not null default false,
  expires_at timestamptz,
  store text,                       -- 'app_store', 'play_store', 'stripe', 'sandbox'
  updated_at timestamptz not null default now(),
  primary key (user_id, entitlement)
);

create table audit_log (
  id bigint generated always as identity primary key,
  actor text not null,              -- 'service:ingestion', 'user:<uuid>', 'admin:<email>'
  action text not null,
  subject text,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

-- Public read-only competition data: RLS on, anonymous read, no client writes.
do $$
declare t text;
begin
  foreach t in array array[
    'modes', 'segments', 'score_systems', 'divisions', 'seasons', 'ensembles',
    'ensemble_aliases', 'venues', 'events', 'sessions', 'performances',
    'captions', 'awards', 'sources'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "%s_public_read" on %I for select using (true)', t, t);
  end loop;
end $$;

-- Ingestion bookkeeping is service-role only (RLS on, no policies).
alter table ingestion_runs enable row level security;
alter table source_records enable row level security;
alter table corrections enable row level security;
alter table audit_log enable row level security;

-- Per-user tables: owners only.
alter table profiles enable row level security;
create policy profiles_own on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

alter table favorites enable row level security;
create policy favorites_own on favorites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table notification_prefs enable row level security;
create policy notification_prefs_own on notification_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table push_tokens enable row level security;
create policy push_tokens_own on push_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Entitlements: user may read their own; only the service role writes.
alter table entitlements enable row level security;
create policy entitlements_read_own on entitlements
  for select using (auth.uid() = user_id);
