-- Cadence core schema — competition data shared by every mode.
-- Applies to a Supabase/Postgres project. No project is provisioned yet;
-- these migrations are validated by CI for syntax and reviewed like code.
--
-- Conventions:
--  * All timestamps are timestamptz stored in UTC; events keep their local
--    timezone as text so published times can be rendered where they happened.
--  * Every published result carries provenance (source + ingestion run).
--  * Score systems are versioned; scores may only be compared when their
--    divisions share a comparability group (enforced in application code and
--    re-checked by ingestion contract tests).

create table modes (
  id text primary key,              -- 'dci', 'wgi', 'boa', 'acappella', 'showchoir'
  name text not null,
  created_at timestamptz not null default now()
);

create table segments (
  id text primary key,              -- 'dci-tour', 'guard', 'icca', ...
  mode_id text not null references modes (id),
  name text not null,
  ranking_behavior text not null check (ranking_behavior in ('seasonLeaderboard', 'eventBased', 'tournament')),
  created_at timestamptz not null default now()
);

create table score_systems (
  id text primary key,
  name text not null,
  max_value numeric not null,
  precision int not null default 3,
  unit text not null default 'score' check (unit in ('score', 'points')),
  version int not null default 1
);

create table divisions (
  id text primary key,              -- scoped ids: 'world', 'cg-iw', ...
  segment_id text not null references segments (id),
  name text not null,
  short_name text not null,
  score_system_id text not null references score_systems (id),
  comparability_group text not null,
  sort_order int not null default 0
);

create table seasons (
  id bigint generated always as identity primary key,
  mode_id text not null references modes (id),
  year int not null,
  label text,
  unique (mode_id, year)
);

create table ensembles (
  id text primary key,              -- slug, stable across seasons
  mode_id text not null references modes (id),
  name text not null,
  location text,
  created_at timestamptz not null default now()
);

-- Sources publish names inconsistently ("Blue Devils" / "Blue Devils A").
create table ensemble_aliases (
  alias text not null,
  ensemble_id text not null references ensembles (id),
  source_id text,
  primary key (alias, ensemble_id)
);

create table venues (
  id bigint generated always as identity primary key,
  name text not null,
  city text,
  region text,
  country text,
  timezone text
);

create table events (
  id text primary key,
  mode_id text not null references modes (id),
  segment_id text not null references segments (id),
  season_id bigint references seasons (id),
  name text not null,
  event_date date not null,
  timezone text,
  venue_id bigint references venues (id),
  city text,
  region text,                      -- tournament region (ICCA 'Northeast')
  upcoming boolean not null default false,
  source_url text,
  created_at timestamptz not null default now()
);

create index events_mode_date on events (mode_id, event_date desc);

create table sessions (
  id text primary key,
  event_id text not null references events (id) on delete cascade,
  name text not null,               -- 'Prelims', 'Semifinals', 'Finals', 'Results'
  sort_order int not null default 1
);

create table performances (
  id bigint generated always as identity primary key,
  session_id text not null references sessions (id) on delete cascade,
  ensemble_id text not null references ensembles (id),
  division_id text not null references divisions (id),
  score numeric,
  points numeric,
  rank int,
  penalty numeric,
  advanced boolean,
  source_record_id bigint,          -- provenance, set after source_records insert
  unique (session_id, ensemble_id)
);

create index performances_ensemble on performances (ensemble_id);

create table captions (
  id bigint generated always as identity primary key,
  performance_id bigint not null references performances (id) on delete cascade,
  caption text not null,
  score numeric not null
);

create table awards (
  id bigint generated always as identity primary key,
  performance_id bigint not null references performances (id) on delete cascade,
  name text not null
);

-- ---------------------------------------------------------------------------
-- Provenance and ingestion bookkeeping
-- ---------------------------------------------------------------------------

create table sources (
  id text primary key,              -- 'dci-org', 'fixture', ...
  name text not null,
  url text,
  kind text not null check (kind in ('live', 'snapshot', 'fixture')),
  terms_notes text
);

create table ingestion_runs (
  id bigint generated always as identity primary key,
  source_id text not null references sources (id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'skipped')),
  records_upserted int not null default 0,
  error text
);

create table source_records (
  id bigint generated always as identity primary key,
  source_id text not null references sources (id),
  ingestion_run_id bigint references ingestion_runs (id),
  source_key text not null,         -- deterministic key for idempotent upserts
  fetched_at timestamptz not null default now(),
  raw_location text,                -- object-storage path of the raw payload
  unique (source_id, source_key)
);

alter table performances
  add constraint performances_source_fk
  foreign key (source_record_id) references source_records (id);

-- A correction supersedes an earlier published value without erasing it.
create table corrections (
  id bigint generated always as identity primary key,
  performance_id bigint not null references performances (id),
  field text not null,
  old_value text,
  new_value text,
  reason text,
  corrected_at timestamptz not null default now()
);
