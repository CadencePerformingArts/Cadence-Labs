-- ═══════════════════════════════════════════════════════════════════
-- CADENCE — complete database setup
--
-- Every table Cadence needs, on a project where no migration has run yet.
--
-- HOW TO RUN: Supabase dashboard → SQL Editor → New query → paste this
-- whole file → Run. It runs as one transaction: if anything fails nothing
-- is applied, so you can fix and re-run without half-migrated tables.
--
-- Generated from supabase/migrations/*.sql — do not edit by hand.
-- ═══════════════════════════════════════════════════════════════════

begin;


-- ───────────────────────────────────────────────
-- 0001_accounts_foundation.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — accounts foundation
--
-- Profiles, cross-device favorites and preference sync, Cadence+
-- entitlements (service-role-written, Stripe-ready), and the Ensemble Pro /
-- Event Pro claim pipeline. Everything is RLS-guarded.
--
-- Run this FIRST — every later migration builds on profiles,
-- touch_updated_at() and claims.
-- ═══════════════════════════════════════════════════════════════════════

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  app_ns text not null,           -- '' = DCI, 'wgi-perc:' etc — matches client storage namespaces
  name text not null,             -- exact ensemble name as that app renders it
  created_at timestamptz not null default now(),
  primary key (user_id, app_ns, name)
);

create table public.preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,              -- namespaced client key, e.g. 'boa:cad-notify-classes'
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table public.plus_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'none' check (status in ('none','beta','active','canceled')),
  source text,                    -- 'beta-code' | 'stripe' | …
  since timestamptz,
  updated_at timestamptz not null default now()
);

create table public.claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('ensemble','event')),
  app_key text not null,          -- 'dci', 'wgi/guard', 'boa', …
  target_name text not null,
  claimant_role text not null,
  message text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer_note text
);
create index claims_user_idx on public.claims (user_id);
create index claims_status_idx on public.claims (status);

-- shared touch trigger used by every later migration
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger preferences_touch before update on public.preferences
  for each row execute function public.touch_updated_at();
create trigger entitlements_touch before update on public.plus_entitlements
  for each row execute function public.touch_updated_at();

-- every new auth user gets a profile + entitlement row automatically
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  insert into public.plus_entitlements (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.favorites enable row level security;
alter table public.preferences enable row level security;
alter table public.plus_entitlements enable row level security;
alter table public.claims enable row level security;

create policy "own profile read" on public.profiles
  for select using ((select auth.uid()) = id);
create policy "own profile update" on public.profiles
  for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "own favorites read" on public.favorites
  for select using ((select auth.uid()) = user_id);
create policy "own favorites insert" on public.favorites
  for insert with check ((select auth.uid()) = user_id);
create policy "own favorites delete" on public.favorites
  for delete using ((select auth.uid()) = user_id);

create policy "own prefs read" on public.preferences
  for select using ((select auth.uid()) = user_id);
create policy "own prefs insert" on public.preferences
  for insert with check ((select auth.uid()) = user_id);
create policy "own prefs update" on public.preferences
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own prefs delete" on public.preferences
  for delete using ((select auth.uid()) = user_id);

-- entitlements: clients may read their own; only the service role writes
create policy "own entitlement read" on public.plus_entitlements
  for select using ((select auth.uid()) = user_id);

create policy "own claims read" on public.claims
  for select using ((select auth.uid()) = user_id);
create policy "own claims insert" on public.claims
  for insert with check ((select auth.uid()) = user_id);


-- ───────────────────────────────────────────────
-- 0002_stripe_fulfillment.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — Stripe fulfillment plumbing
--
-- Entitlements learn about Stripe, payments that arrive before an account
-- exists park in plus_pending, and the webhook edge function can resolve
-- users by email without exposing auth.users.
--
-- Depends on 0001.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.plus_entitlements
  add column if not exists stripe_customer_id text,
  add column if not exists plan text;
create index if not exists plus_entitlements_customer_idx
  on public.plus_entitlements (stripe_customer_id);

create table public.plus_pending (
  email text primary key,          -- stored lowercased
  stripe_customer_id text,
  plan text,
  status text not null default 'active',
  since timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.plus_pending enable row level security;
-- no policies: service role only

create trigger plus_pending_touch before update on public.plus_pending
  for each row execute function public.touch_updated_at();

-- service-role-only email → user id lookup, used by the Stripe webhook
create or replace function public.get_user_id_by_email(p_email text)
returns uuid language sql security definer set search_path = public, auth as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1
$$;
revoke execute on function public.get_user_id_by_email(text) from public, anon, authenticated;

-- when a new user signs up, absorb any entitlement parked for their email
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare pend public.plus_pending%rowtype;
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  insert into public.plus_entitlements (user_id) values (new.id) on conflict do nothing;
  select * into pend from public.plus_pending where email = lower(new.email);
  if found then
    update public.plus_entitlements
       set status = pend.status, source = 'stripe', plan = pend.plan,
           stripe_customer_id = pend.stripe_customer_id, since = pend.since
     where user_id = new.id;
    delete from public.plus_pending where email = pend.email;
  end if;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;


-- ───────────────────────────────────────────────
-- 0003_usage_analytics.sql
-- ───────────────────────────────────────────────
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


-- ───────────────────────────────────────────────
-- 0004_ensemble_pro.sql
-- ───────────────────────────────────────────────
-- Ensemble Pro v1 — organizations claim and manage their official profile.
--
-- An approved `claims` row (kind='ensemble') is the key that unlocks writing
-- an `ensemble_profiles` row for that exact (app_key, ensemble_name). Claims
-- themselves are verified by hand — nothing here auto-approves anything.
--
-- ─── Owner: run this file once in the Supabase SQL editor. ───
--
-- Approval workflow (run in SQL editor as needed):
--
--   List pending claims, oldest first:
--     select c.id, c.created_at, c.kind, c.app_key, c.target_name,
--            c.claimant_role, c.message, c.user_id, u.email
--       from public.claims c
--       left join auth.users u on u.id = c.user_id
--      where c.status = 'pending'
--      order by c.created_at;
--
--   Approve a claim (after verifying the person really represents the org —
--   e.g. an email from the ensemble's official domain, or a reply from a
--   published contact address):
--     update public.claims
--        set status = 'approved', reviewed_at = now(),
--            reviewer_note = 'verified via official email'
--      where id = '<claim uuid>';
--
--   Reject a claim:
--     update public.claims
--        set status = 'rejected', reviewed_at = now(),
--            reviewer_note = 'could not verify affiliation'
--      where id = '<claim uuid>';
--
--   See every published ensemble profile:
--     select app_key, ensemble_name, owner_user_id, published, updated_at
--       from public.ensemble_profiles order by app_key, ensemble_name;

-- ---------------------------------------------------------------------------
-- profiles.role — platform roles (plain users vs. the platform admin).
-- Clients can never set this: column-level UPDATE/INSERT on `role` is revoked
-- below, so even though `profiles_own` is FOR ALL, a user writing their own
-- profile row cannot touch `role`. Only the service role / SQL editor can.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists role text not null default 'user'
  constraint profiles_role_check check (role in ('user', 'platform_admin'));

-- Column-level REVOKE cannot carve a column out of a table-wide grant, so drop
-- the table-wide write privileges and re-grant only the client-writable
-- columns. (Adding a client-writable column to profiles later means adding it
-- to these grants too.) SELECT/DELETE stay table-wide; RLS still scopes every
-- operation to the user's own row.
revoke insert, update on public.profiles from anon, authenticated;
grant insert (id, display_name), update (display_name) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- ensemble_profiles — one row per claimed ensemble per app.
--
-- `content` is a single jsonb document owned by the ensemble. Canonical shape
-- (all keys optional; the client renders only what it recognizes):
--   {
--     "description":   text,
--     "show_title":    text,
--     "repertoire":    text,
--     "staff":         [{ "name": text, "role": text }],
--     "website":       url,
--     "socials":       { "instagram"|"facebook"|"x"|"youtube"|"tiktok": url },
--     "auditions":     { "info": text, "link": url },
--     "open_positions":[ text ],
--     "merch_url":     url,
--     "donate_url":    url,
--     "sponsors":      [{ "name": text, "url": url }],
--     "announcements": [{ "ts": iso8601, "title": text, "body": text }],
--     "videos":        [ url ],
--     "alumni":        text,
--     "logo_url":      url,
--     "cover_url":     url
--   }
-- ---------------------------------------------------------------------------

create table public.ensemble_profiles (
  id uuid primary key default gen_random_uuid(),
  app_key text not null,            -- '' (DCI), 'boa', 'wgi/guard', … matches docs/<key>/
  ensemble_name text not null,      -- exactly as in that app's corps_index.json
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  published boolean not null default true,
  content jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_key, ensemble_name)
);

create index ensemble_profiles_owner_idx on public.ensemble_profiles (owner_user_id);

-- keep updated_at honest on every write (helper ships with the claims
-- migration; create or replace keeps this file self-sufficient)
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger ensemble_profiles_touch
  before update on public.ensemble_profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Read: anyone can read published profiles; owners always see their own.
-- Write: only the owner, and only while they hold an approved ensemble claim
-- for that exact (app_key, target_name). Revoking a claim (set status back to
-- 'pending' or 'rejected') instantly freezes the profile without deleting it.
-- ---------------------------------------------------------------------------

-- Security-definer helper so policies stay one readable line. Runs as the
-- table owner (bypasses RLS on claims), pinned search_path, and is granted
-- only to `authenticated` — it is a policy internal, not a public RPC.
create or replace function public.has_approved_ensemble_claim(p_app_key text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.claims c
     where c.user_id = auth.uid()
       and c.kind = 'ensemble'
       and c.app_key = p_app_key
       and c.target_name = p_name
       and c.status = 'approved'
  );
$$;

revoke execute on function public.has_approved_ensemble_claim(text, text) from public, anon;
grant execute on function public.has_approved_ensemble_claim(text, text) to authenticated;

alter table public.ensemble_profiles enable row level security;

create policy ensemble_profiles_public_read on public.ensemble_profiles
  for select to anon, authenticated
  using (published);

create policy ensemble_profiles_owner_read on public.ensemble_profiles
  for select to authenticated
  using (owner_user_id = auth.uid());

create policy ensemble_profiles_owner_insert on public.ensemble_profiles
  for insert to authenticated
  with check (
    owner_user_id = auth.uid()
    and public.has_approved_ensemble_claim(app_key, ensemble_name)
  );

create policy ensemble_profiles_owner_update on public.ensemble_profiles
  for update to authenticated
  using (
    owner_user_id = auth.uid()
    and public.has_approved_ensemble_claim(app_key, ensemble_name)
  )
  with check (
    owner_user_id = auth.uid()
    and public.has_approved_ensemble_claim(app_key, ensemble_name)
  );

create policy ensemble_profiles_owner_delete on public.ensemble_profiles
  for delete to authenticated
  using (
    owner_user_id = auth.uid()
    and public.has_approved_ensemble_claim(app_key, ensemble_name)
  );


-- ───────────────────────────────────────────────
-- 0005_ensemble_core.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE ENSEMBLE — core foundation (Phase 1)
--
-- The private side of Cadence: organization workspaces, memberships,
-- configurable roles, granular permissions, groups, invites, access
-- requests, seasons, audit log, and the subscription/entitlement fields
-- that gate everything.
--
-- Everything private lives behind RLS keyed on organization membership.
-- Public Cadence (scores/rankings/profiles) is untouched by this file.
--
-- ─── Owner: run this once in the Supabase SQL editor. ───
-- Depends on: 0001 (profiles, touch_updated_at), 0004 (ensemble_profiles).
-- ═══════════════════════════════════════════════════════════════════════

-- ── umbrella programs (a school band program containing several ensembles)
create table public.org_programs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'none',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── organizations (the workspace itself)
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  program_id uuid references public.org_programs(id) on delete set null,
  name text not null,
  slug text not null unique,
  org_type text not null default 'marching_band',
    -- drum_corps | marching_band | concert_band | wgi_percussion | wgi_guard
    -- | wgi_winds | winter_guard | indoor_percussion | booster | school_music
    -- | independent
  -- link to the PUBLIC Cadence identity, so competition data can flow in
  public_app_key text,          -- '' (DCI) | 'boa' | 'wgi/guard' | 'uil' | …
  public_ensemble_name text,    -- exact name as that app's data spells it
  -- discovery: may this workspace be found from its public profile?
  directory_visible boolean not null default true,
  accepting_requests boolean not null default true,
  -- ── subscription / entitlement ─────────────────────────────────────
  plan text not null default 'trial'
    check (plan in ('trial', 'ensemble', 'pro', 'program', 'none')),
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'invoice_pending',
                      'grace_period', 'read_only', 'canceled', 'expired')),
  trial_ends_at timestamptz not null default (now() + interval '60 days'),
  grace_ends_at timestamptz,
  renews_at timestamptz,
  billing_owner_user_id uuid references auth.users(id) on delete set null,
  stripe_customer_id text,
  storage_quota_bytes bigint not null default 1073741824,   -- 1 GB on trial/free
  storage_used_bytes bigint not null default 0,
  trial_member_limit int not null default 20,
  -- org-level policy switches (youth safety, comms rules) — see settings keys
  -- below; app reads these, RLS enforces the ones that matter server-side
  settings jsonb not null default jsonb_build_object(
    'student_dms', false,          -- students may DM each other
    'student_staff_dms', false,    -- students may DM staff privately
    'member_created_chats', false, -- non-staff may create chats
    'parents_view_member_chats', false,
    'directory_contacts_visible_to', 'staff'  -- staff | members | none
  ),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index organizations_program_idx on public.organizations (program_id);
create index organizations_public_idx on public.organizations (public_app_key, public_ensemble_name);

-- ── seasons (organizations run year after year; history is preserved)
create table public.org_seasons (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,                       -- '2026 Marching Season'
  starts_on date,
  ends_on date,
  is_current boolean not null default false,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index org_seasons_org_idx on public.org_seasons (org_id);

-- ── roles: system defaults are seeded per org and fully editable; orgs may
--    add their own (Battery Staff, Prop Crew, Hospitality, …)
create table public.org_roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,                        -- 'director', 'battery_staff', …
  name text not null,
  kind text not null default 'member'
    check (kind in ('owner', 'staff', 'leadership', 'member', 'parent',
                    'booster', 'volunteer', 'alumni', 'guest')),
  permissions text[] not null default '{}',
  is_system boolean not null default false, -- seeded default (still editable)
  sort int not null default 100,
  created_at timestamptz not null default now(),
  unique (org_id, key)
);

-- Permission vocabulary (stored in org_roles.permissions):
--   org.admin           — implies every permission below
--   billing.manage      audit.view          member.manage
--   announce.view       announce.create     announce.edit     announce.urgent
--   chat.create         chat.moderate
--   event.create        event.edit          attendance.view   attendance.edit
--   file.view           file.upload         file.manage
--   group.create        group.manage
--   form.manage         signup.manage       task.manage       poll.manage
--   assignment.manage   audition.manage     equipment.manage
--   staff.access        student.info        parent.info
--   public.manage       — edits the PUBLIC ensemble profile (Ensemble Pro)

-- ── members
create table public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,  -- null = invited placeholder
  role_id uuid not null references public.org_roles(id) on delete restrict,
  display_name text,
  section text,                 -- 'Trumpet', 'Snare', 'Rifle', …
  instrument text,
  grad_year int,
  leadership_title text,        -- 'Drum Major', 'Section Leader', …
  is_minor boolean not null default false,
  status text not null default 'active'
    check (status in ('active', 'pending', 'inactive', 'alumni')),
  season_id uuid references public.org_seasons(id) on delete set null,
  joined_at timestamptz not null default now(),
  custom jsonb not null default '{}',
  unique (org_id, user_id)
);
create index org_members_org_idx on public.org_members (org_id, status);
create index org_members_user_idx on public.org_members (user_id);

-- ── member contact details live apart from the roster so directory reads
--    never leak phone/email/parent contacts to peers
create table public.org_member_contacts (
  member_id uuid primary key references public.org_members(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text,
  phone text,
  address text,
  emergency_name text,
  emergency_phone text,
  notes text,
  updated_at timestamptz not null default now()
);

-- ── groups (sections, staff rooms, parent groups, community groups) —
--    nestable, so Trumpets ⊂ Brass ⊂ Full Ensemble
create table public.org_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  parent_id uuid references public.org_groups(id) on delete cascade,
  name text not null,
  kind text not null default 'section'
    check (kind in ('ensemble', 'section', 'staff', 'leadership', 'parent',
                    'booster', 'volunteer', 'community', 'custom')),
  description text,
  -- members holding any of these role keys join automatically
  auto_role_keys text[] not null default '{}',
  -- members whose section matches any of these join automatically
  auto_sections text[] not null default '{}',
  season_id uuid references public.org_seasons(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index org_groups_org_idx on public.org_groups (org_id);
create index org_groups_parent_idx on public.org_groups (parent_id);

create table public.org_group_members (
  group_id uuid not null references public.org_groups(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (group_id, member_id)
);
create index org_group_members_member_idx on public.org_group_members (member_id);

-- ── invites (email, link, code, QR — all the same row)
create table public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  code text not null unique,
  email text,
  role_id uuid references public.org_roles(id) on delete set null,
  group_ids uuid[] not null default '{}',
  section text,
  note text,
  max_uses int not null default 1,
  uses int not null default 0,
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ── access requests from the public profile ("I'm a parent in this band")
create table public.org_access_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  requested_kind text not null default 'member',
  message text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer_note text,
  unique (org_id, user_id)
);

-- ── audit log
create table public.org_audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index org_audit_org_idx on public.org_audit_log (org_id, created_at desc);

-- ═══ helper functions (SECURITY DEFINER so member checks don't recurse) ═══

create or replace function public.is_org_member(p_org uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_members m
     where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
  )
$$;

create or replace function public.org_has_perm(p_org uuid, p_perm text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_members m
      join public.org_roles r on r.id = m.role_id
     where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
       and ('org.admin' = any(r.permissions) or p_perm = any(r.permissions))
  )
$$;

-- writable = the subscription still allows creating content. read_only /
-- expired / canceled workspaces keep every byte of history readable.
create or replace function public.org_writable(p_org uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.organizations o
     where o.id = p_org
       and (o.status in ('active', 'past_due', 'invoice_pending', 'grace_period')
            or (o.status = 'trialing' and o.trial_ends_at > now()))
  )
$$;

-- may I write content of this kind here? (membership + permission + plan)
create or replace function public.org_can_write(p_org uuid, p_perm text)
returns boolean language sql security definer stable set search_path = public as $$
  select public.org_has_perm(p_org, p_perm) and public.org_writable(p_org)
$$;

-- my member row id in an org — used by feature tables to attribute content
create or replace function public.org_member_id(p_org uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select m.id from public.org_members m
   where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
   limit 1
$$;

-- am I in this group (directly, or via a descendant/ancestor auto-join)?
create or replace function public.is_group_member(p_group uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_group_members gm
      join public.org_members m on m.id = gm.member_id
     where gm.group_id = p_group and m.user_id = auth.uid() and m.status = 'active'
  )
$$;

revoke execute on function public.is_org_member(uuid) from public, anon;
revoke execute on function public.org_has_perm(uuid, text) from public, anon;
revoke execute on function public.org_writable(uuid) from public, anon;
revoke execute on function public.org_can_write(uuid, text) from public, anon;
revoke execute on function public.org_member_id(uuid) from public, anon;
revoke execute on function public.is_group_member(uuid) from public, anon;
-- …but signed-in users MUST be able to execute them: RLS policies are
-- evaluated with the caller's privileges, so a policy calling a function the
-- caller can't execute fails with "permission denied for function".
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.org_has_perm(uuid, text) to authenticated;
grant execute on function public.org_writable(uuid) to authenticated;
grant execute on function public.org_can_write(uuid, text) to authenticated;
grant execute on function public.org_member_id(uuid) to authenticated;
grant execute on function public.is_group_member(uuid) to authenticated;

-- ═══ seeding: a new organization gets its default roles, groups, season,
--     and its creator as owner — in one transaction, server-side ═══

create or replace function public.seed_new_organization()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  owner_role uuid;
  season uuid;
  full_ens uuid;
begin
  insert into public.org_roles (org_id, key, name, kind, permissions, is_system, sort) values
    (new.id, 'owner', 'Owner', 'owner', array['org.admin','billing.manage'], true, 10),
    (new.id, 'director', 'Director', 'staff', array['org.admin'], true, 20),
    (new.id, 'assistant_director', 'Assistant Director', 'staff',
      array['announce.view','announce.create','announce.edit','announce.urgent','event.create','event.edit',
            'attendance.view','attendance.edit','file.view','file.upload','file.manage','group.create',
            'group.manage','member.manage','chat.create','chat.moderate','form.manage','signup.manage',
            'task.manage','poll.manage','assignment.manage','staff.access','student.info','parent.info'], true, 30),
    (new.id, 'staff', 'Staff', 'staff',
      array['announce.view','announce.create','event.create','attendance.view','attendance.edit',
            'file.view','file.upload','chat.create','task.manage','assignment.manage','staff.access',
            'student.info'], true, 40),
    (new.id, 'instructor', 'Instructor', 'staff',
      array['announce.view','announce.create','attendance.view','attendance.edit','file.view',
            'file.upload','chat.create','assignment.manage','staff.access'], true, 50),
    (new.id, 'leadership', 'Section Leader / Drum Major', 'leadership',
      array['announce.view','announce.create','attendance.view','file.view','file.upload'], true, 60),
    (new.id, 'member', 'Member', 'member', array['announce.view','file.view'], true, 70),
    (new.id, 'parent', 'Parent / Guardian', 'parent', array['announce.view','file.view'], true, 80),
    (new.id, 'booster_officer', 'Booster Officer', 'booster',
      array['announce.view','announce.create','file.view','file.upload','signup.manage'], true, 90),
    (new.id, 'booster', 'Booster', 'booster', array['announce.view','file.view'], true, 100),
    (new.id, 'volunteer', 'Volunteer', 'volunteer', array['announce.view'], true, 110),
    (new.id, 'alumni', 'Alumni', 'alumni', array['announce.view'], true, 120),
    (new.id, 'guest', 'Guest', 'guest', array['announce.view'], true, 130);

  select id into owner_role from public.org_roles where org_id = new.id and key = 'owner';

  insert into public.org_seasons (org_id, name, is_current)
  values (new.id, to_char(now(), 'YYYY') || ' Season', true)
  returning id into season;

  insert into public.org_groups (org_id, name, kind, season_id, auto_role_keys)
  values (new.id, 'Full Ensemble', 'ensemble', season,
          array['member','leadership','staff','instructor','director','assistant_director','owner'])
  returning id into full_ens;

  insert into public.org_groups (org_id, name, kind, season_id, auto_role_keys) values
    (new.id, 'Staff', 'staff', season, array['staff','instructor','director','assistant_director','owner']),
    (new.id, 'All Parents', 'parent', season, array['parent']),
    (new.id, 'Boosters', 'booster', season, array['booster','booster_officer']);

  insert into public.org_members (org_id, user_id, role_id, status, season_id)
  values (new.id, new.created_by, owner_role, 'active', season);

  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (new.id, new.created_by, 'organization.created', 'organization', new.id::text);

  return new;
end $$;

create trigger organizations_seed after insert on public.organizations
  for each row execute function public.seed_new_organization();

-- keep group membership in sync with roles/sections without admin busywork
create or replace function public.sync_member_auto_groups()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rkey text;
begin
  select key into rkey from public.org_roles where id = new.role_id;
  delete from public.org_group_members gm
    using public.org_groups g
   where gm.member_id = new.id and g.id = gm.group_id
     and (cardinality(g.auto_role_keys) > 0 or cardinality(g.auto_sections) > 0)
     and not (rkey = any(g.auto_role_keys)
              or (new.section is not null and new.section = any(g.auto_sections)));
  insert into public.org_group_members (group_id, member_id)
    select g.id, new.id from public.org_groups g
     where g.org_id = new.org_id
       and (rkey = any(g.auto_role_keys)
            or (new.section is not null and new.section = any(g.auto_sections)))
  on conflict do nothing;
  return new;
end $$;

create trigger org_members_autogroup after insert or update of role_id, section
  on public.org_members for each row execute function public.sync_member_auto_groups();

-- Billing is not self-serve. An org admin runs the workspace, but plan,
-- status, trial dates and storage limits are set by the billing system
-- (service role / webhook) — otherwise any admin could grant themselves a
-- paid plan and unlimited storage with one PATCH.
-- SECURITY INVOKER on purpose: this must see the CALLER's role. Inside a
-- SECURITY DEFINER function current_user is the function owner, which would
-- lock out the billing system itself.
create or replace function public.guard_org_billing_fields()
returns trigger language plpgsql set search_path = public as $$
declare claims_role text;
begin
  claims_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if claims_role = 'service_role' or current_user = 'service_role' then
    return new;                       -- billing system may write anything
  end if;
  if new.plan is distinct from old.plan
     or new.status is distinct from old.status
     or new.trial_ends_at is distinct from old.trial_ends_at
     or new.grace_ends_at is distinct from old.grace_ends_at
     or new.renews_at is distinct from old.renews_at
     or new.storage_quota_bytes is distinct from old.storage_quota_bytes
     or new.stripe_customer_id is distinct from old.stripe_customer_id then
    raise exception
      'billing_fields_readonly: plan, status, trial dates and storage limits are set by billing';
  end if;
  return new;
end $$;

create trigger organizations_guard_billing before update on public.organizations
  for each row execute function public.guard_org_billing_fields();

-- the audit log records who actually acted, not who the client claims
create or replace function public.stamp_audit_actor()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.actor_user_id := auth.uid();
  return new;
end $$;

create trigger org_audit_actor before insert on public.org_audit_log
  for each row execute function public.stamp_audit_actor();

create trigger organizations_touch before update on public.organizations
  for each row execute function public.touch_updated_at();
create trigger org_programs_touch before update on public.org_programs
  for each row execute function public.touch_updated_at();
create trigger org_member_contacts_touch before update on public.org_member_contacts
  for each row execute function public.touch_updated_at();

-- ═══ RLS ═══
alter table public.org_programs enable row level security;
alter table public.organizations enable row level security;
alter table public.org_seasons enable row level security;
alter table public.org_roles enable row level security;
alter table public.org_members enable row level security;
alter table public.org_member_contacts enable row level security;
alter table public.org_groups enable row level security;
alter table public.org_group_members enable row level security;
alter table public.org_invites enable row level security;
alter table public.org_access_requests enable row level security;
alter table public.org_audit_log enable row level security;

-- organizations: members read their own; any signed-in user may create one;
-- admins update; billing owner/admins handle plan fields (app-enforced)
create policy org_read on public.organizations for select to authenticated
  using (public.is_org_member(id));
create policy org_create on public.organizations for insert to authenticated
  with check (created_by = auth.uid());
create policy org_update on public.organizations for update to authenticated
  using (public.org_has_perm(id, 'org.admin'))
  with check (public.org_has_perm(id, 'org.admin'));

create policy prog_read on public.org_programs for select to authenticated
  using (owner_user_id = auth.uid() or exists (
    select 1 from public.organizations o
     where o.program_id = org_programs.id and public.is_org_member(o.id)));
create policy prog_write on public.org_programs for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

create policy season_read on public.org_seasons for select to authenticated
  using (public.is_org_member(org_id));
create policy season_write on public.org_seasons for all to authenticated
  using (public.org_can_write(org_id, 'org.admin'))
  with check (public.org_can_write(org_id, 'org.admin'));

create policy roles_read on public.org_roles for select to authenticated
  using (public.is_org_member(org_id));
create policy roles_write on public.org_roles for all to authenticated
  using (public.org_can_write(org_id, 'member.manage'))
  with check (public.org_can_write(org_id, 'member.manage'));

create policy members_read on public.org_members for select to authenticated
  using (public.is_org_member(org_id));
create policy members_write on public.org_members for all to authenticated
  using (public.org_can_write(org_id, 'member.manage'))
  with check (public.org_can_write(org_id, 'member.manage'));
-- members may edit their own roster details (not their role)
create policy members_self on public.org_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- contacts: yourself, or staff holding student.info / parent.info
create policy contacts_read on public.org_member_contacts for select to authenticated
  using (
    member_id = public.org_member_id(org_id)
    or public.org_has_perm(org_id, 'student.info')
    or public.org_has_perm(org_id, 'parent.info')
  );
create policy contacts_self_write on public.org_member_contacts for all to authenticated
  using (member_id = public.org_member_id(org_id))
  with check (member_id = public.org_member_id(org_id));
create policy contacts_staff_write on public.org_member_contacts for all to authenticated
  using (public.org_can_write(org_id, 'member.manage'))
  with check (public.org_can_write(org_id, 'member.manage'));

create policy groups_read on public.org_groups for select to authenticated
  using (public.is_org_member(org_id));
create policy groups_write on public.org_groups for all to authenticated
  using (public.org_can_write(org_id, 'group.create'))
  with check (public.org_can_write(org_id, 'group.create'));

create policy gm_read on public.org_group_members for select to authenticated
  using (exists (select 1 from public.org_groups g
                  where g.id = group_id and public.is_org_member(g.org_id)));
create policy gm_write on public.org_group_members for all to authenticated
  using (exists (select 1 from public.org_groups g
                  where g.id = group_id and public.org_can_write(g.org_id, 'group.manage')))
  with check (exists (select 1 from public.org_groups g
                  where g.id = group_id and public.org_can_write(g.org_id, 'group.manage')));

create policy invites_admin on public.org_invites for all to authenticated
  using (public.org_can_write(org_id, 'member.manage'))
  with check (public.org_can_write(org_id, 'member.manage'));

create policy reqs_own on public.org_access_requests for select to authenticated
  using (user_id = auth.uid() or public.org_has_perm(org_id, 'member.manage'));
create policy reqs_insert on public.org_access_requests for insert to authenticated
  with check (user_id = auth.uid());
create policy reqs_review on public.org_access_requests for update to authenticated
  using (public.org_can_write(org_id, 'member.manage'))
  with check (public.org_can_write(org_id, 'member.manage'));

create policy audit_read on public.org_audit_log for select to authenticated
  using (public.org_has_perm(org_id, 'audit.view') or public.org_has_perm(org_id, 'org.admin'));
create policy audit_insert on public.org_audit_log for insert to authenticated
  with check (public.is_org_member(org_id));

-- ── redeeming an invite: server-side so codes never expose the org to
--    non-members, and so role/group assignment can't be forged
create or replace function public.redeem_org_invite(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  inv public.org_invites%rowtype;
  member uuid;
  season uuid;
begin
  select * into inv from public.org_invites
   where code = p_code and (expires_at is null or expires_at > now()) and uses < max_uses;
  if not found then raise exception 'invite_invalid'; end if;
  if auth.uid() is null then raise exception 'auth_required'; end if;

  select id into member from public.org_members where org_id = inv.org_id and user_id = auth.uid();
  if member is not null then return inv.org_id; end if;

  select id into season from public.org_seasons
   where org_id = inv.org_id and is_current order by created_at desc limit 1;

  insert into public.org_members (org_id, user_id, role_id, section, status, season_id)
  values (inv.org_id, auth.uid(),
          coalesce(inv.role_id, (select id from public.org_roles where org_id = inv.org_id and key = 'member')),
          inv.section, 'active', season)
  returning id into member;

  insert into public.org_group_members (group_id, member_id)
    select unnest(inv.group_ids), member on conflict do nothing;

  update public.org_invites set uses = uses + 1 where id = inv.id;
  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (inv.org_id, auth.uid(), 'member.joined_via_invite', 'member', member::text);
  return inv.org_id;
end $$;
revoke execute on function public.redeem_org_invite(text) from public, anon;
grant execute on function public.redeem_org_invite(text) to authenticated;

-- ── public discovery surface: name/type only, never private content
create view public.org_directory
  with (security_invoker = false) as
  select id, name, slug, org_type, public_app_key, public_ensemble_name, accepting_requests
    from public.organizations
   where directory_visible;
grant select on public.org_directory to anon, authenticated;

-- ═══ Owner workflow queries ═══
-- Approve an access request, then add the member with the role you intend:
--   update org_access_requests set status='approved', reviewed_at=now() where id='…';
-- Extend a trial:
--   update organizations set trial_ends_at = now() + interval '30 days' where slug='…';
-- Activate a paid plan after payment:
--   update organizations set plan='pro', status='active',
--     renews_at = now() + interval '1 year', storage_quota_bytes = 26843545600
--    where slug='…';
-- Nightly sweep (trial → read_only, grace → read_only) — run as a cron job:
--   update organizations set status='read_only'
--    where (status='trialing' and trial_ends_at < now())
--       or (status='grace_period' and grace_ends_at < now());


-- ───────────────────────────────────────────────
-- 0006_ensemble_comms.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE ENSEMBLE — communication (Phase 2)
--
-- Everything an organization says to itself:
--   • posts  — the feed. Announcements and ordinary posts, with priority,
--     targeting (whole org / groups / role kinds / named individuals),
--     pinning, scheduled publishing, required acknowledgment, comments,
--     reactions and read receipts.
--   • chats  — org-wide, per-group, staff-only, event and direct messages,
--     with replies, reactions, edit/soft-delete, pinning, and a moderation
--     report queue that leaves a trail.
--   • org_notification_prefs — per-member delivery levels, with the one
--     rule the product will not bend on: URGENT ALWAYS DELIVERS.
--
-- Visibility is computed SERVER-SIDE. The browser never decides who may
-- read a post: can_see_post() does, and every dependent table (comments,
-- reactions, acks, reads, targets) cascades off it. Youth-safety switches
-- in organizations.settings (student_dms, student_staff_dms,
-- member_created_chats) are enforced by RLS, not by hiding buttons.
--
-- ─── Owner notes ───────────────────────────────────────────────────────
--  • Run once in the Supabase SQL editor, after 0005_ensemble_core.sql.
--  • Depends on 0005 helpers: is_org_member, org_has_perm, org_writable,
--    org_can_write, org_member_id, is_group_member; and on 0001's
--    touch_updated_at().
--  • The tail of this file adds messages/posts/comments/reactions to the
--    `supabase_realtime` publication. The Feed and Messages screens use
--    Realtime, not polling — if you skip that block, both pages still work
--    but stop updating live.
--  • public.org_plan_has() mirrors the plan→feature matrix in
--    docs/ensemble/core.js. It is intentionally generic so later feature
--    migrations can reuse it; keep the two in sync if plans change.
--  • Nothing here is destructive. Posts archive, messages soft-delete
--    (deleted_at) — history is preserved for the life of the workspace.
-- ═══════════════════════════════════════════════════════════════════════

-- ═══ plan/entitlement helper (mirrors PLANS + PRO_FEATURES in core.js) ═══
create or replace function public.org_plan_has(p_org uuid, p_feature text)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when o.plan in ('trial', 'pro', 'program') then true
    when o.plan = 'ensemble' then p_feature not in (
      'staff_workspace', 'itineraries', 'packing_lists', 'assignments',
      'submissions', 'equipment', 'uniforms', 'auditions',
      'advanced_permissions', 'advanced_reporting', 'acknowledgments',
      'volunteer_management', 'automation')
    else false
  end
  from public.organizations o where o.id = p_org
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- POSTS — the feed
-- ═══════════════════════════════════════════════════════════════════════

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  author_member_id uuid references public.org_members(id) on delete set null,
  kind text not null default 'post'
    check (kind in ('post', 'announcement')),
  priority text not null default 'normal'
    check (priority in ('normal', 'important', 'urgent')),
  title text,
  body text not null default '',
  attachments jsonb not null default '[]',
  pinned boolean not null default false,
  requires_ack boolean not null default false,
  publish_at timestamptz not null default now(),   -- future = scheduled
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index posts_org_idx on public.posts (org_id, archived, pinned desc, publish_at desc);
create index posts_author_idx on public.posts (author_member_id);

-- Targeting. ZERO rows for a post = org-wide. Otherwise the post is visible
-- to members matching ANY row (group membership OR role kind OR named member).
create table public.post_targets (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  group_id uuid references public.org_groups(id) on delete cascade,
  role_kind text
    check (role_kind is null or role_kind in ('owner', 'staff', 'leadership',
           'member', 'parent', 'booster', 'volunteer', 'alumni', 'guest')),
  member_id uuid references public.org_members(id) on delete cascade,
  constraint post_targets_one_dimension check (
    (group_id is not null)::int + (role_kind is not null)::int
      + (member_id is not null)::int = 1
  )
);
create index post_targets_post_idx on public.post_targets (post_id);
create index post_targets_group_idx on public.post_targets (group_id);
create index post_targets_member_idx on public.post_targets (member_id);

-- "187 of 204 acknowledged"
create table public.post_acks (
  post_id uuid not null references public.posts(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  acked_at timestamptz not null default now(),
  primary key (post_id, member_id)
);
create index post_acks_member_idx on public.post_acks (member_id);

create table public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  member_id uuid references public.org_members(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index post_comments_post_idx on public.post_comments (post_id, created_at);

create table public.post_reactions (
  post_id uuid not null references public.posts(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, member_id, emoji)
);

create table public.post_reads (
  post_id uuid not null references public.posts(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (post_id, member_id)
);

create trigger posts_touch before update on public.posts
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- CHATS — conversations
-- ═══════════════════════════════════════════════════════════════════════

create table public.chats (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null default 'group'
    check (kind in ('org', 'group', 'staff', 'dm', 'event')),
  group_id uuid references public.org_groups(id) on delete set null,
  title text,
  created_by_member uuid references public.org_members(id) on delete set null,
  is_moderated boolean not null default true,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index chats_org_idx on public.chats (org_id, kind);
create unique index chats_one_org_wide on public.chats (org_id) where kind = 'org';

create table public.chat_members (
  chat_id uuid not null references public.chats(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  last_read_at timestamptz,
  muted boolean not null default false,
  added_at timestamptz not null default now(),
  primary key (chat_id, member_id)
);
create index chat_members_member_idx on public.chat_members (member_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  member_id uuid references public.org_members(id) on delete set null,
  body text not null default '',
  attachments jsonb not null default '[]',
  reply_to uuid references public.messages(id) on delete set null,
  pinned boolean not null default false,   -- pinned messages, per screen spec
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index messages_chat_idx on public.messages (chat_id, created_at desc);
create index messages_pinned_idx on public.messages (chat_id) where pinned;

create table public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, member_id, emoji)
);

-- moderation trail: reports are never deleted, only resolved
create table public.message_reports (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  reporter_member_id uuid references public.org_members(id) on delete set null,
  reason text,
  status text not null default 'open'
    check (status in ('open', 'reviewing', 'actioned', 'dismissed')),
  resolved_by_member uuid references public.org_members(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index message_reports_msg_idx on public.message_reports (message_id);

-- ═══════════════════════════════════════════════════════════════════════
-- NOTIFICATION PREFERENCES
--   scope_id is the org / group / chat id the preference applies to, so the
--   composite primary key needs no nullable column.
--   'none' silences everything EXCEPT urgent announcements — enforced by
--   should_notify() below, which every delivery path must call.
-- ═══════════════════════════════════════════════════════════════════════

create table public.org_notification_prefs (
  member_id uuid not null references public.org_members(id) on delete cascade,
  scope text not null check (scope in ('org', 'group', 'chat')),
  scope_id uuid not null,
  channel text not null check (channel in ('push', 'email')),
  level text not null default 'all'
    check (level in ('all', 'important', 'urgent', 'none')),
  updated_at timestamptz not null default now(),
  primary key (member_id, scope, scope_id, channel)
);

comment on column public.org_notification_prefs.level is
  'all | important | urgent | none. "none" never suppresses priority=urgent '
  'announcements — see public.should_notify().';

-- ═══════════════════════════════════════════════════════════════════════
-- HELPERS (SECURITY DEFINER so policies never recurse into RLS)
-- ═══════════════════════════════════════════════════════════════════════

-- THE visibility rule for the feed. True when the caller is an active member
-- of the post's org AND the post is untargeted (org-wide) or the caller
-- matches at least one target row by group, role kind, or member id.
create or replace function public.can_see_post(p_post uuid)
returns boolean language sql security definer stable set search_path = public as $$
  with p as (
    select id, org_id from public.posts where id = p_post
  ), me as (
    select m.id, m.role_id
      from public.org_members m join p on p.org_id = m.org_id
     where m.user_id = auth.uid() and m.status = 'active'
     limit 1
  )
  select exists (select 1 from me)
     and (
       not exists (select 1 from public.post_targets t where t.post_id = p_post)
       or exists (
         select 1 from public.post_targets t cross join me
          where t.post_id = p_post
            and (
              (t.member_id is not null and t.member_id = me.id)
              or (t.group_id is not null and exists (
                    select 1 from public.org_group_members gm
                     where gm.group_id = t.group_id and gm.member_id = me.id))
              or (t.role_kind is not null and exists (
                    select 1 from public.org_roles r
                     where r.id = me.role_id and r.kind = t.role_kind))
            )
       )
     )
$$;

-- may the caller edit/administer this post? (author, or announce.edit)
create or replace function public.can_edit_post(p_post uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.posts p
     where p.id = p_post
       and (p.author_member_id = public.org_member_id(p.org_id)
            or public.org_has_perm(p.org_id, 'announce.edit'))
  )
$$;

-- my org_members.id in the org that owns this post (null if not a member)
create or replace function public.post_member_id(p_post uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select public.org_member_id((select org_id from public.posts where id = p_post))
$$;

create or replace function public.post_org(p_post uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select org_id from public.posts where id = p_post
$$;

create or replace function public.chat_org(p_chat uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select org_id from public.chats where id = p_chat
$$;

-- did I open this room, or do I moderate it? (SECURITY DEFINER on purpose:
-- policies must not have to SELECT chats through chats' own RLS, or a fresh
-- DM would be unreachable by the person who just created it.)
create or replace function public.chat_creator_or_mod(p_chat uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.chats c
     where c.id = p_chat
       and (c.created_by_member = public.org_member_id(c.org_id)
            or public.org_has_perm(c.org_id, 'chat.moderate'))
  )
$$;

create or replace function public.chat_member_id(p_chat uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select public.org_member_id(public.chat_org(p_chat))
$$;

create or replace function public.is_chat_member(p_chat uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.chat_members cm
      join public.org_members m on m.id = cm.member_id
     where cm.chat_id = p_chat and m.user_id = auth.uid() and m.status = 'active'
  )
$$;

-- staff-ish role kinds get the adult side of the youth-safety rules
create or replace function public.member_is_staff(p_member uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_members m join public.org_roles r on r.id = m.role_id
     where m.id = p_member and r.kind in ('owner', 'staff')
  )
$$;

-- ── youth safety: may these two members hold a private conversation?
--    If neither is a minor, yes. If either is:
--      minor ↔ minor  → organizations.settings.student_dms
--      minor ↔ staff  → organizations.settings.student_staff_dms
--    A parent/booster/volunteer counts as "not staff" here on purpose:
--    only role kinds owner/staff are treated as supervised adults.
create or replace function public.pair_may_dm(p_a uuid, p_b uuid)
returns boolean language sql security definer stable set search_path = public as $$
  with a as (select org_id, is_minor from public.org_members where id = p_a),
       b as (select org_id, is_minor from public.org_members where id = p_b),
       s as (select o.settings from public.organizations o
              join a on a.org_id = o.id)
  select case
    when not exists (select 1 from a) or not exists (select 1 from b) then false
    when (select org_id from a) is distinct from (select org_id from b) then false
    when p_a = p_b then true
    when not ((select is_minor from a) or (select is_minor from b)) then true
    when public.member_is_staff(p_a) and public.member_is_staff(p_b) then true
    when public.member_is_staff(p_a) or public.member_is_staff(p_b)
      then coalesce(((select settings from s) ->> 'student_staff_dms')::boolean, false)
    else coalesce(((select settings from s) ->> 'student_dms')::boolean, false)
  end
$$;

-- may this member be added to this chat under the youth-safety rules?
-- Non-DM chats are always fine; a DM must pass pair_may_dm() against every
-- member already in it.
create or replace function public.dm_allowed(p_chat uuid, p_member uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when (select kind from public.chats where id = p_chat) is distinct from 'dm' then true
    else not exists (
      select 1 from public.chat_members cm
       where cm.chat_id = p_chat and cm.member_id <> p_member
         and not public.pair_may_dm(cm.member_id, p_member))
  end
$$;

-- may the caller start a chat here at all? (chat.create, or the org has
-- opted members into creating their own chats)
create or replace function public.may_create_chat(p_org uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.org_writable(p_org)
     and (
       public.org_has_perm(p_org, 'chat.create')
       or (public.is_org_member(p_org) and coalesce(
             (select (o.settings ->> 'member_created_chats')::boolean
                from public.organizations o where o.id = p_org), false))
     )
$$;

-- an open chat is one an ordinary member may join themselves
create or replace function public.chat_is_open(p_chat uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.chats c
     where c.id = p_chat
       and public.is_org_member(c.org_id)
       and (c.kind = 'org'
            or (c.kind = 'group' and c.group_id is not null
                and public.is_group_member(c.group_id))
            or (c.kind = 'staff' and public.org_has_perm(c.org_id, 'staff.access')))
  )
$$;

-- ── the one rule notifications must obey. Delivery code calls this instead
--    of reading `level` directly: urgent announcements always get through.
create or replace function public.should_notify(
  p_member uuid, p_scope text, p_scope_id uuid, p_channel text, p_priority text)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when p_priority = 'urgent' then true            -- never silenceable
    else case coalesce((
      select level from public.org_notification_prefs
       where member_id = p_member and scope = p_scope
         and scope_id = p_scope_id and channel = p_channel), 'all')
      when 'none' then false
      when 'urgent' then false                       -- urgent handled above
      when 'important' then p_priority in ('important', 'urgent')
      else true
    end
  end
$$;

revoke execute on function public.org_plan_has(uuid, text) from public, anon;
revoke execute on function public.can_see_post(uuid) from public, anon;
revoke execute on function public.can_edit_post(uuid) from public, anon;
revoke execute on function public.post_member_id(uuid) from public, anon;
revoke execute on function public.post_org(uuid) from public, anon;
revoke execute on function public.chat_org(uuid) from public, anon;
revoke execute on function public.chat_creator_or_mod(uuid) from public, anon;
revoke execute on function public.chat_member_id(uuid) from public, anon;
revoke execute on function public.is_chat_member(uuid) from public, anon;
revoke execute on function public.member_is_staff(uuid) from public, anon;
revoke execute on function public.pair_may_dm(uuid, uuid) from public, anon;
revoke execute on function public.dm_allowed(uuid, uuid) from public, anon;
revoke execute on function public.may_create_chat(uuid) from public, anon;
revoke execute on function public.chat_is_open(uuid) from public, anon;
revoke execute on function public.should_notify(uuid, text, uuid, text, text) from public, anon;

-- ═══════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════
alter table public.posts enable row level security;
alter table public.post_targets enable row level security;
alter table public.post_acks enable row level security;
alter table public.post_comments enable row level security;
alter table public.post_reactions enable row level security;
alter table public.post_reads enable row level security;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.message_reports enable row level security;
alter table public.org_notification_prefs enable row level security;

-- ── posts ──────────────────────────────────────────────────────────────
-- read: targeting decides, and scheduled posts stay hidden until publish_at.
-- Authors and announcement editors always see their own drafts/schedules.
create policy posts_read on public.posts for select to authenticated
  using (
    (public.can_see_post(id) and publish_at <= now())
    or author_member_id = public.org_member_id(org_id)
    or public.org_has_perm(org_id, 'announce.edit')
  );

create policy posts_insert on public.posts for insert to authenticated
  with check (
    public.org_can_write(org_id, 'announce.create')
    and author_member_id = public.org_member_id(org_id)
    and (priority <> 'urgent' or public.org_has_perm(org_id, 'announce.urgent'))
    and (requires_ack = false or public.org_plan_has(org_id, 'acknowledgments'))
  );

-- authors may always edit their own; editing anyone else's needs announce.edit
create policy posts_update on public.posts for update to authenticated
  using (
    public.org_writable(org_id)
    and (author_member_id = public.org_member_id(org_id)
         or public.org_has_perm(org_id, 'announce.edit'))
  )
  with check (
    public.org_writable(org_id)
    and (author_member_id = public.org_member_id(org_id)
         or public.org_has_perm(org_id, 'announce.edit'))
    and (priority <> 'urgent' or public.org_has_perm(org_id, 'announce.urgent'))
    and (requires_ack = false or public.org_plan_has(org_id, 'acknowledgments'))
  );

-- deletion is a last resort; the product archives. announce.edit only.
create policy posts_delete on public.posts for delete to authenticated
  using (public.org_can_write(org_id, 'announce.edit'));

-- ── post_targets ───────────────────────────────────────────────────────
create policy ptargets_read on public.post_targets for select to authenticated
  using (public.can_see_post(post_id) or public.can_edit_post(post_id));
create policy ptargets_write on public.post_targets for all to authenticated
  using (public.can_edit_post(post_id)) with check (public.can_edit_post(post_id));

-- ── acknowledgments ────────────────────────────────────────────────────
-- Everyone who can see a post can see its ack roll — that is the point of a
-- required acknowledgment: "who has read this" is not a secret from the room.
create policy acks_read on public.post_acks for select to authenticated
  using (public.can_see_post(post_id) or public.can_edit_post(post_id));
create policy acks_insert on public.post_acks for insert to authenticated
  with check (public.can_see_post(post_id) and member_id = public.post_member_id(post_id));
create policy acks_delete on public.post_acks for delete to authenticated
  using (member_id = public.post_member_id(post_id));

-- ── comments ───────────────────────────────────────────────────────────
create policy pcomments_read on public.post_comments for select to authenticated
  using (public.can_see_post(post_id) or public.can_edit_post(post_id));
create policy pcomments_insert on public.post_comments for insert to authenticated
  with check (
    public.can_see_post(post_id)
    and member_id = public.post_member_id(post_id)
    and public.org_writable(public.post_org(post_id))
  );
create policy pcomments_update on public.post_comments for update to authenticated
  using (member_id = public.post_member_id(post_id) or public.can_edit_post(post_id))
  with check (member_id = public.post_member_id(post_id) or public.can_edit_post(post_id));
create policy pcomments_delete on public.post_comments for delete to authenticated
  using (member_id = public.post_member_id(post_id) or public.can_edit_post(post_id));

-- ── reactions & reads ──────────────────────────────────────────────────
create policy preactions_read on public.post_reactions for select to authenticated
  using (public.can_see_post(post_id) or public.can_edit_post(post_id));
create policy preactions_write on public.post_reactions for all to authenticated
  using (member_id = public.post_member_id(post_id))
  with check (public.can_see_post(post_id) and member_id = public.post_member_id(post_id));

create policy preads_read on public.post_reads for select to authenticated
  using (member_id = public.post_member_id(post_id) or public.can_edit_post(post_id));
create policy preads_write on public.post_reads for all to authenticated
  using (member_id = public.post_member_id(post_id))
  with check (public.can_see_post(post_id) and member_id = public.post_member_id(post_id));

-- ── chats ──────────────────────────────────────────────────────────────
-- You see a chat you belong to, an open chat you're eligible to join, or —
-- if you moderate — any chat in the org, so reports can be acted on.
create policy chats_read on public.chats for select to authenticated
  using (
    public.is_chat_member(id)
    or public.chat_is_open(id)
    or created_by_member = public.org_member_id(org_id)   -- your own new DM
    or public.org_has_perm(org_id, 'chat.moderate')
  );

create policy chats_insert on public.chats for insert to authenticated
  with check (
    public.may_create_chat(org_id)
    and created_by_member = public.org_member_id(org_id)
    -- a staff-only room needs staff access; a group room needs the group
    and (kind <> 'staff' or public.org_has_perm(org_id, 'staff.access'))
    and (kind <> 'group' or group_id is null
         or public.is_group_member(group_id)
         or public.org_has_perm(org_id, 'group.manage'))
  );

create policy chats_update on public.chats for update to authenticated
  using (
    public.org_writable(org_id)
    and (created_by_member = public.org_member_id(org_id)
         or public.org_has_perm(org_id, 'chat.moderate'))
  )
  with check (
    created_by_member = public.org_member_id(org_id)
    or public.org_has_perm(org_id, 'chat.moderate')
  );

create policy chats_delete on public.chats for delete to authenticated
  using (public.org_can_write(org_id, 'chat.moderate'));

-- ── chat membership ────────────────────────────────────────────────────
create policy cmembers_read on public.chat_members for select to authenticated
  using (public.is_chat_member(chat_id)
         or public.org_has_perm(public.chat_org(chat_id), 'chat.moderate'));

-- Adding someone: the chat's creator, a moderator, or yourself joining an
-- open room. Every path also has to satisfy the DM rules.
create policy cmembers_insert on public.chat_members for insert to authenticated
  with check (
    public.org_writable(public.chat_org(chat_id))
    and public.dm_allowed(chat_id, member_id)
    and (
      public.chat_creator_or_mod(chat_id)
      or (member_id = public.chat_member_id(chat_id) and public.chat_is_open(chat_id))
    )
  );

-- your own row (last_read_at, muted) is yours; moderators may fix any
create policy cmembers_update on public.chat_members for update to authenticated
  using (member_id = public.chat_member_id(chat_id)
         or public.org_has_perm(public.chat_org(chat_id), 'chat.moderate'))
  with check (member_id = public.chat_member_id(chat_id)
         or public.org_has_perm(public.chat_org(chat_id), 'chat.moderate'));

create policy cmembers_delete on public.chat_members for delete to authenticated
  using (member_id = public.chat_member_id(chat_id)
         or public.chat_creator_or_mod(chat_id));

-- ── messages ───────────────────────────────────────────────────────────
create policy messages_read on public.messages for select to authenticated
  using (public.is_chat_member(chat_id)
         or public.org_has_perm(public.chat_org(chat_id), 'chat.moderate'));

create policy messages_insert on public.messages for insert to authenticated
  with check (
    public.is_chat_member(chat_id)
    and member_id = public.chat_member_id(chat_id)
    and public.org_writable(public.chat_org(chat_id))
  );

-- edit your own; moderators may soft-delete or pin anything
create policy messages_update on public.messages for update to authenticated
  using (
    public.org_writable(public.chat_org(chat_id))
    and (member_id = public.chat_member_id(chat_id)
         or public.org_has_perm(public.chat_org(chat_id), 'chat.moderate'))
  )
  with check (
    member_id = public.chat_member_id(chat_id)
    or public.org_has_perm(public.chat_org(chat_id), 'chat.moderate')
  );

-- hard delete is moderator-only; the UI uses deleted_at so threads stay legible
create policy messages_delete on public.messages for delete to authenticated
  using (public.org_can_write(public.chat_org(chat_id), 'chat.moderate'));

create policy mreactions_read on public.message_reactions for select to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_id and public.is_chat_member(m.chat_id)));
create policy mreactions_write on public.message_reactions for all to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_id and member_id = public.chat_member_id(m.chat_id)))
  with check (exists (select 1 from public.messages m
                  where m.id = message_id
                    and public.is_chat_member(m.chat_id)
                    and member_id = public.chat_member_id(m.chat_id)));

-- ── reports: reporters see their own, moderators see the queue ─────────
create policy mreports_read on public.message_reports for select to authenticated
  using (
    exists (select 1 from public.messages m
             where m.id = message_id
               and (reporter_member_id = public.chat_member_id(m.chat_id)
                    or public.org_has_perm(public.chat_org(m.chat_id), 'chat.moderate')))
  );
create policy mreports_insert on public.message_reports for insert to authenticated
  with check (
    exists (select 1 from public.messages m
             where m.id = message_id
               and public.is_chat_member(m.chat_id)
               and reporter_member_id = public.chat_member_id(m.chat_id))
  );
create policy mreports_update on public.message_reports for update to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_id
                    and public.org_has_perm(public.chat_org(m.chat_id), 'chat.moderate')))
  with check (exists (select 1 from public.messages m
                  where m.id = message_id
                    and public.org_has_perm(public.chat_org(m.chat_id), 'chat.moderate')));

-- ── notification preferences: strictly your own ────────────────────────
create policy notif_own on public.org_notification_prefs for all to authenticated
  using (exists (select 1 from public.org_members m
                  where m.id = member_id and m.user_id = auth.uid()))
  with check (exists (select 1 from public.org_members m
                  where m.id = member_id and m.user_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════════
-- REALTIME — the Feed and Messages screens subscribe to postgres_changes.
-- Replica identity full so UPDATE payloads carry the whole row (edits,
-- soft-deletes and pin toggles all arrive as UPDATEs).
-- ═══════════════════════════════════════════════════════════════════════
alter table public.messages replica identity full;
alter table public.posts replica identity full;
alter table public.post_comments replica identity full;
alter table public.post_reactions replica identity full;
alter table public.post_acks replica identity full;
alter table public.message_reactions replica identity full;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['messages', 'posts', 'post_comments',
                             'post_reactions', 'post_acks', 'message_reactions']
    loop
      if not exists (
        select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- Owner workflow queries
--
--   -- who still owes an acknowledgment on a post?
--   select m.display_name from org_members m
--    where m.org_id = '…' and m.status = 'active'
--      and m.id not in (select member_id from post_acks where post_id = '…');
--
--   -- open moderation queue for a workspace
--   select r.*, msg.body from message_reports r
--     join messages msg on msg.id = r.message_id
--     join chats c on c.id = msg.chat_id
--    where c.org_id = '…' and r.status = 'open' order by r.created_at;
--
--   -- turn student DMs on for one organization
--   update organizations
--      set settings = settings || '{"student_dms":true}'::jsonb
--    where slug = '…';
--
--   -- create the org-wide chat by hand (the Messages screen also offers this)
--   insert into chats (org_id, kind, title, created_by_member)
--   values ('…', 'org', 'Everyone', '…member id…');
-- ═══════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────
-- 0007_ensemble_ops.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE ENSEMBLE — operations (Phase 3)
--
-- Everything a marching organization actually *runs on* between the
-- announcement and the awards ceremony:
--
--   events + targeting      who the thing is for (whole org, or groups)
--   RSVPs                   yes / no / maybe, with parent-on-behalf-of
--   attendance              present / absent / late / excused / left early
--   itineraries             the minute-by-minute competition-day timeline
--   packing lists           templates, per-member checkoff
--   signups                 slots, capacity, automatic waitlist
--   tasks                   assigned to members or whole groups
--   polls                   single/multi, anonymous, staged result visibility
--
-- Plus the columns that make Cadence Ensemble different from every generic
-- team app: an event may point at a REAL competition in public Cadence
-- (public_app_key / public_event_key / public_event_date), so the private
-- calendar entry and the public scoring dataset are the same show. The
-- browser resolves those keys against the static datasets under
-- docs/<app>/data/ — see docs/ensemble/ops.js.
--
-- ─── Owner: run this once in the Supabase SQL editor, after 0005. ───
-- Depends on: 0001 (touch_updated_at), 0005 (organizations, org_members,
--             org_roles, org_groups, org_group_members, org_seasons,
--             is_org_member, org_has_perm, org_can_write, org_writable,
--             org_member_id, is_group_member).
--
-- Permission vocabulary used here (declared in 0005):
--   event.create  event.edit  attendance.view  attendance.edit
--   signup.manage task.manage poll.manage      org.admin
--
-- A note on GRANTs: policy expressions are evaluated with the calling role's
-- privileges, so every helper a policy touches must stay EXECUTE-able by
-- `authenticated`. We therefore revoke from `anon` (and from PUBLIC where the
-- function is only reached through a policy) and grant explicitly to
-- `authenticated` — never a blanket `revoke ... from public` on a helper a
-- policy depends on.
-- ═══════════════════════════════════════════════════════════════════════


-- ═══ 0. org_guardians ═══════════════════════════════════════════════════
-- The guardian ⇄ student link. This table is *shared* with the members/admin
-- migration; whichever file runs first creates it. Created here with
-- `create table if not exists` and policies guarded by a catalog lookup so
-- running both files in either order is safe.
--
-- ⚠ If the members/admin migration also defines org_guardians, keep ONE
--   definition (they must agree on: guardian_member_id, member_id, org_id,
--   primary key (guardian_member_id, member_id)).

create table if not exists public.org_guardians (
  guardian_member_id uuid not null references public.org_members(id) on delete cascade,
  member_id          uuid not null references public.org_members(id) on delete cascade,
  org_id             uuid not null references public.organizations(id) on delete cascade,
  created_at         timestamptz not null default now(),
  primary key (guardian_member_id, member_id)
);
create index if not exists org_guardians_member_idx on public.org_guardians (member_id);
create index if not exists org_guardians_org_idx    on public.org_guardians (org_id);

alter table public.org_guardians enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'org_guardians'
                    and policyname = 'guardians_read') then
    execute 'create policy guardians_read on public.org_guardians
               for select to authenticated using (public.is_org_member(org_id))';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'org_guardians'
                    and policyname = 'guardians_write') then
    execute 'create policy guardians_write on public.org_guardians
               for all to authenticated
               using (public.org_can_write(org_id, ''member.manage''))
               with check (public.org_can_write(org_id, ''member.manage''))';
  end if;
end $$;


-- ═══ 1. events ══════════════════════════════════════════════════════════

create table public.org_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  season_id uuid references public.org_seasons(id) on delete set null,
  title text not null,
  kind text not null default 'rehearsal'
    check (kind in ('rehearsal', 'competition', 'performance', 'game', 'camp',
                    'meeting', 'fundraiser', 'travel', 'sectional', 'audition',
                    'other')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  location text,
  address text,
  description text,
  attachments jsonb not null default '[]'::jsonb,   -- [{name,path,size,mime}]
  rsvp_required boolean not null default false,
  attendance_required boolean not null default false,
  -- ── the public↔private bridge ────────────────────────────────────────
  -- Points at a real competition in public Cadence. public_app_key matches
  -- organizations.public_app_key ('' = DCI, 'boa', 'wgi/guard', 'uil', …);
  -- public_event_key is the slug of that show's name in the app's dataset;
  -- public_event_date is its date, which selects seasons/<year>.json.
  public_app_key text,
  public_event_key text,
  public_event_date date,
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);
create index org_events_org_idx on public.org_events (org_id, starts_at);
create index org_events_season_idx on public.org_events (season_id);
create index org_events_public_idx on public.org_events (public_app_key, public_event_key);

create trigger org_events_touch before update on public.org_events
  for each row execute function public.touch_updated_at();

-- who the event is for. No rows at all = the whole organization.
create table public.org_event_targets (
  event_id uuid not null references public.org_events(id) on delete cascade,
  group_id uuid not null references public.org_groups(id) on delete cascade,
  primary key (event_id, group_id)
);
create index org_event_targets_group_idx on public.org_event_targets (group_id);

create table public.org_event_rsvps (
  event_id uuid not null references public.org_events(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  response text not null check (response in ('yes', 'no', 'maybe')),
  note text,
  responded_by_user uuid references auth.users(id) on delete set null,
  responded_at timestamptz not null default now(),
  primary key (event_id, member_id)
);
create index org_event_rsvps_member_idx on public.org_event_rsvps (member_id);

create table public.org_attendance (
  event_id uuid not null references public.org_events(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  status text not null
    check (status in ('present', 'absent', 'late', 'excused', 'left_early')),
  note text,
  recorded_by_member uuid references public.org_members(id) on delete set null,
  recorded_at timestamptz not null default now(),
  primary key (event_id, member_id)
);
create index org_attendance_member_idx on public.org_attendance (member_id);


-- ═══ 2. itineraries — the competition-day timeline ══════════════════════

create table public.org_itineraries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references public.org_events(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.org_itinerary_items (
  id uuid primary key default gen_random_uuid(),
  itinerary_id uuid not null references public.org_itineraries(id) on delete cascade,
  at_time timestamptz not null,
  title text not null,
  detail text,
  -- optional: this line only applies to one group (Battery loads at 5:40…)
  group_id uuid references public.org_groups(id) on delete set null,
  sort int not null default 0
);
create index org_itinerary_items_it_idx on public.org_itinerary_items (itinerary_id, at_time, sort);


-- ═══ 3. packing lists ═══════════════════════════════════════════════════

create table public.org_packing_lists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid references public.org_events(id) on delete cascade,  -- null = org template
  name text not null,
  is_template boolean not null default false,
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index org_packing_lists_org_idx on public.org_packing_lists (org_id);
create index org_packing_lists_event_idx on public.org_packing_lists (event_id);

create table public.org_packing_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.org_packing_lists(id) on delete cascade,
  label text not null,
  group_id uuid references public.org_groups(id) on delete set null,  -- e.g. guard only
  sort int not null default 0
);
create index org_packing_items_list_idx on public.org_packing_items (list_id, sort);

create table public.org_packing_checks (
  item_id uuid not null references public.org_packing_items(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  checked_at timestamptz not null default now(),
  primary key (item_id, member_id)
);
create index org_packing_checks_member_idx on public.org_packing_checks (member_id);


-- ═══ 4. signups (volunteer slots, chaperones, pit crew, meal shifts) ════

create table public.org_signups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid references public.org_events(id) on delete cascade,
  title text not null,
  description text,
  closes_at timestamptz,
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index org_signups_org_idx on public.org_signups (org_id);
create index org_signups_event_idx on public.org_signups (event_id);

create table public.org_signup_slots (
  id uuid primary key default gen_random_uuid(),
  signup_id uuid not null references public.org_signups(id) on delete cascade,
  label text not null,
  starts_at timestamptz,
  ends_at timestamptz,
  capacity int not null default 1 check (capacity >= 0),  -- 0 = unlimited
  notes text,
  sort int not null default 0
);
create index org_signup_slots_signup_idx on public.org_signup_slots (signup_id, sort);

create table public.org_signup_claims (
  slot_id uuid not null references public.org_signup_slots(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  note text,
  waitlisted boolean not null default false,   -- claimed past capacity
  claimed_at timestamptz not null default now(),
  primary key (slot_id, member_id)
);
create index org_signup_claims_member_idx on public.org_signup_claims (member_id);
create index org_signup_claims_wait_idx on public.org_signup_claims (slot_id, waitlisted, claimed_at);


-- ═══ 5. tasks ═══════════════════════════════════════════════════════════

create table public.org_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  detail text,
  due_on date,
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high')),
  status text not null default 'open'
    check (status in ('open', 'doing', 'done')),
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index org_tasks_org_idx on public.org_tasks (org_id, status, due_on);

create trigger org_tasks_touch before update on public.org_tasks
  for each row execute function public.touch_updated_at();

create table public.org_task_assignees (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.org_tasks(id) on delete cascade,
  member_id uuid references public.org_members(id) on delete cascade,
  group_id uuid references public.org_groups(id) on delete cascade,
  check (num_nonnulls(member_id, group_id) = 1)
);
create unique index org_task_assignees_member_uq on public.org_task_assignees (task_id, member_id)
  where member_id is not null;
create unique index org_task_assignees_group_uq on public.org_task_assignees (task_id, group_id)
  where group_id is not null;


-- ═══ 6. polls ═══════════════════════════════════════════════════════════

create table public.org_polls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  question text not null,
  kind text not null default 'single' check (kind in ('single', 'multi')),
  anonymous boolean not null default false,
  closes_at timestamptz,
  results_visible text not null default 'always'
    check (results_visible in ('always', 'after_close', 'staff')),
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index org_polls_org_idx on public.org_polls (org_id, created_at desc);

create table public.org_poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.org_polls(id) on delete cascade,
  label text not null,
  sort int not null default 0
);
create index org_poll_options_poll_idx on public.org_poll_options (poll_id, sort);

create table public.org_poll_votes (
  poll_id uuid not null references public.org_polls(id) on delete cascade,
  option_id uuid not null references public.org_poll_options(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (option_id, member_id)
);
create index org_poll_votes_poll_idx on public.org_poll_votes (poll_id, member_id);


-- ═══════════════════════════════════════════════════════════════════════
-- HELPERS — SECURITY DEFINER so policies can look past RLS without
-- recursing. Every one pins search_path.
-- ═══════════════════════════════════════════════════════════════════════

-- the org an event belongs to (null if the event is gone)
create or replace function public.event_org(p_event uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select e.org_id from public.org_events e where e.id = p_event
$$;

-- ── THE targeting rule, in one place. Reused by every child table so
--    "who can see this event" is defined exactly once.
--    Visible when: I'm an active member of the org AND
--      (the event has no group targets  — it's for everyone), OR
--      (I'm in one of the targeted groups), OR
--      (I'm staff who can edit events / an admin — staff see everything).
create or replace function public.can_see_event(p_event uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
      from public.org_events e
     where e.id = p_event
       and public.is_org_member(e.org_id)
       and (
         not exists (select 1 from public.org_event_targets t where t.event_id = e.id)
         or exists (
              select 1
                from public.org_event_targets t
                join public.org_group_members gm on gm.group_id = t.group_id
                join public.org_members m on m.id = gm.member_id
               where t.event_id = e.id
                 and m.user_id = auth.uid()
                 and m.status = 'active')
         or public.org_has_perm(e.org_id, 'event.edit')
         or public.org_has_perm(e.org_id, 'attendance.view')
       )
  )
$$;

-- may I change this event and its children (itinerary, packing, targets)?
-- event.edit anywhere in the org, or event.create on an event I made.
create or replace function public.can_manage_event(p_event uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_events e
     where e.id = p_event
       and (public.org_can_write(e.org_id, 'event.edit')
            or (public.org_can_write(e.org_id, 'event.create')
                and e.created_by_member is not distinct from public.org_member_id(e.org_id)))
  )
$$;

-- am I this member, or their guardian? Guardians must hold a role whose kind
-- is 'parent' — a link alone is not enough.
create or replace function public.org_acts_for_member(p_member uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_members m
     where m.id = p_member and m.user_id = auth.uid() and m.status = 'active'
  ) or exists (
    select 1
      from public.org_guardians g
      join public.org_members gm on gm.id = g.guardian_member_id
      join public.org_roles r on r.id = gm.role_id
     where g.member_id = p_member
       and gm.user_id = auth.uid()
       and gm.status = 'active'
       and r.kind = 'parent'
  )
$$;

-- packing lists / signups may hang off an event or off the org itself
create or replace function public.can_see_packing_list(p_list uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_packing_lists l
     where l.id = p_list
       and public.is_org_member(l.org_id)
       and (l.event_id is null or public.can_see_event(l.event_id))
  )
$$;

create or replace function public.can_manage_packing_list(p_list uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_packing_lists l
     where l.id = p_list
       and (public.org_can_write(l.org_id, 'event.edit')
            or public.org_can_write(l.org_id, 'event.create'))
  )
$$;

create or replace function public.can_see_signup(p_signup uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_signups s
     where s.id = p_signup
       and public.is_org_member(s.org_id)
       and (s.event_id is null or public.can_see_event(s.event_id))
  )
$$;

create or replace function public.signup_org(p_signup uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select s.org_id from public.org_signups s where s.id = p_signup
$$;

create or replace function public.slot_signup(p_slot uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select l.signup_id from public.org_signup_slots l where l.id = p_slot
$$;

-- assigned to me directly, or to a group I'm in
create or replace function public.is_task_assignee(p_task uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
      from public.org_task_assignees a
      left join public.org_members m on m.id = a.member_id
      left join public.org_group_members gm on gm.group_id = a.group_id
      left join public.org_members gmm on gmm.id = gm.member_id
     where a.task_id = p_task
       and ((m.user_id = auth.uid() and m.status = 'active')
            or (gmm.user_id = auth.uid() and gmm.status = 'active'))
  )
$$;

-- may I see the tally for this poll? (own votes are always visible)
create or replace function public.poll_results_visible(p_poll uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_polls p
     where p.id = p_poll
       and public.is_org_member(p.org_id)
       and (public.org_has_perm(p.org_id, 'poll.manage')
            or p.results_visible = 'always'
            or (p.results_visible = 'after_close'
                and p.closes_at is not null and p.closes_at <= now()))
  )
$$;

revoke execute on function public.event_org(uuid) from anon;
revoke execute on function public.can_see_event(uuid) from anon;
revoke execute on function public.can_manage_event(uuid) from anon;
revoke execute on function public.org_acts_for_member(uuid) from anon;
revoke execute on function public.can_see_packing_list(uuid) from anon;
revoke execute on function public.can_manage_packing_list(uuid) from anon;
revoke execute on function public.can_see_signup(uuid) from anon;
revoke execute on function public.signup_org(uuid) from anon;
revoke execute on function public.slot_signup(uuid) from anon;
revoke execute on function public.is_task_assignee(uuid) from anon;
revoke execute on function public.poll_results_visible(uuid) from anon;

grant execute on function public.event_org(uuid) to authenticated;
grant execute on function public.can_see_event(uuid) to authenticated;
grant execute on function public.can_manage_event(uuid) to authenticated;
grant execute on function public.org_acts_for_member(uuid) to authenticated;
grant execute on function public.can_see_packing_list(uuid) to authenticated;
grant execute on function public.can_manage_packing_list(uuid) to authenticated;
grant execute on function public.can_see_signup(uuid) to authenticated;
grant execute on function public.signup_org(uuid) to authenticated;
grant execute on function public.slot_signup(uuid) to authenticated;
grant execute on function public.is_task_assignee(uuid) to authenticated;
grant execute on function public.poll_results_visible(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- RLS
--
--   READ   membership in the org, plus the targeting rule (can_see_event)
--          wherever an event is involved.
--   WRITE  org_can_write(org, perm) — which folds in permission AND an
--          unexpired subscription, so a read-only workspace keeps all of
--          its history but stops accepting new rows.
--   SELF   a member may always write their own RSVP, packing checks,
--          signup claims and poll votes; their own attendance *note* goes
--          through an RPC so they cannot mark themselves present.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.org_events          enable row level security;
alter table public.org_event_targets   enable row level security;
alter table public.org_event_rsvps     enable row level security;
alter table public.org_attendance      enable row level security;
alter table public.org_itineraries     enable row level security;
alter table public.org_itinerary_items enable row level security;
alter table public.org_packing_lists   enable row level security;
alter table public.org_packing_items   enable row level security;
alter table public.org_packing_checks  enable row level security;
alter table public.org_signups         enable row level security;
alter table public.org_signup_slots    enable row level security;
alter table public.org_signup_claims   enable row level security;
alter table public.org_tasks           enable row level security;
alter table public.org_task_assignees  enable row level security;
alter table public.org_polls           enable row level security;
alter table public.org_poll_options    enable row level security;
alter table public.org_poll_votes      enable row level security;

-- ── events
create policy events_read on public.org_events for select to authenticated
  using (public.can_see_event(id));
create policy events_insert on public.org_events for insert to authenticated
  with check (public.org_can_write(org_id, 'event.create'));
create policy events_update on public.org_events for update to authenticated
  using (public.can_manage_event(id))
  with check (public.org_can_write(org_id, 'event.create')
              or public.org_can_write(org_id, 'event.edit'));
create policy events_delete on public.org_events for delete to authenticated
  using (public.can_manage_event(id));

create policy event_targets_read on public.org_event_targets for select to authenticated
  using (public.can_see_event(event_id));
create policy event_targets_write on public.org_event_targets for all to authenticated
  using (public.can_manage_event(event_id))
  with check (public.can_manage_event(event_id));

-- ── RSVPs: everyone who can see the event sees the counts; you write your
--    own row, a parent writes their student's, staff may fix any of them.
create policy rsvps_read on public.org_event_rsvps for select to authenticated
  using (public.can_see_event(event_id));
create policy rsvps_self_write on public.org_event_rsvps for all to authenticated
  using (public.org_acts_for_member(member_id)
         and public.can_see_event(event_id)
         and public.org_writable(public.event_org(event_id)))
  with check (public.org_acts_for_member(member_id)
              and public.can_see_event(event_id)
              and public.org_writable(public.event_org(event_id)));
create policy rsvps_staff_write on public.org_event_rsvps for all to authenticated
  using (public.can_manage_event(event_id))
  with check (public.can_manage_event(event_id));

-- ── attendance: a student's record is not peer-visible. Staff with
--    attendance.view/edit see the grid; you and your guardian see yours.
create policy attendance_read on public.org_attendance for select to authenticated
  using (public.can_see_event(event_id)
         and (public.org_has_perm(public.event_org(event_id), 'attendance.view')
              or public.org_has_perm(public.event_org(event_id), 'attendance.edit')
              or public.org_acts_for_member(member_id)));
create policy attendance_write on public.org_attendance for all to authenticated
  using (public.org_can_write(public.event_org(event_id), 'attendance.edit'))
  with check (public.org_can_write(public.event_org(event_id), 'attendance.edit'));

-- ── itineraries
create policy itin_read on public.org_itineraries for select to authenticated
  using (public.can_see_event(event_id));
create policy itin_write on public.org_itineraries for all to authenticated
  using (public.can_manage_event(event_id))
  with check (public.can_manage_event(event_id));

create policy itin_items_read on public.org_itinerary_items for select to authenticated
  using (exists (select 1 from public.org_itineraries i
                  where i.id = itinerary_id and public.can_see_event(i.event_id)));
create policy itin_items_write on public.org_itinerary_items for all to authenticated
  using (exists (select 1 from public.org_itineraries i
                  where i.id = itinerary_id and public.can_manage_event(i.event_id)))
  with check (exists (select 1 from public.org_itineraries i
                  where i.id = itinerary_id and public.can_manage_event(i.event_id)));

-- ── packing lists
create policy packlist_read on public.org_packing_lists for select to authenticated
  using (public.is_org_member(org_id)
         and (event_id is null or public.can_see_event(event_id)));
create policy packlist_write on public.org_packing_lists for all to authenticated
  using (public.org_can_write(org_id, 'event.edit') or public.org_can_write(org_id, 'event.create'))
  with check (public.org_can_write(org_id, 'event.edit') or public.org_can_write(org_id, 'event.create'));

create policy packitem_read on public.org_packing_items for select to authenticated
  using (public.can_see_packing_list(list_id));
create policy packitem_write on public.org_packing_items for all to authenticated
  using (public.can_manage_packing_list(list_id))
  with check (public.can_manage_packing_list(list_id));

-- your own checkboxes; staff may see everyone's to chase down the missing
create policy packcheck_read on public.org_packing_checks for select to authenticated
  using (exists (select 1 from public.org_packing_items pi
                  where pi.id = item_id and public.can_see_packing_list(pi.list_id)));
create policy packcheck_self on public.org_packing_checks for all to authenticated
  using (public.org_acts_for_member(member_id)
         and exists (select 1 from public.org_packing_items pi
                      where pi.id = item_id and public.can_see_packing_list(pi.list_id)))
  with check (public.org_acts_for_member(member_id)
         and exists (select 1 from public.org_packing_items pi
                      where pi.id = item_id and public.can_see_packing_list(pi.list_id)));

-- ── signups
create policy signup_read on public.org_signups for select to authenticated
  using (public.is_org_member(org_id)
         and (event_id is null or public.can_see_event(event_id)));
create policy signup_write on public.org_signups for all to authenticated
  using (public.org_can_write(org_id, 'signup.manage'))
  with check (public.org_can_write(org_id, 'signup.manage'));

create policy signup_slot_read on public.org_signup_slots for select to authenticated
  using (public.can_see_signup(signup_id));
create policy signup_slot_write on public.org_signup_slots for all to authenticated
  using (public.org_can_write(public.signup_org(signup_id), 'signup.manage'))
  with check (public.org_can_write(public.signup_org(signup_id), 'signup.manage'));

create policy signup_claim_read on public.org_signup_claims for select to authenticated
  using (public.can_see_signup(public.slot_signup(slot_id)));
create policy signup_claim_self on public.org_signup_claims for all to authenticated
  using (public.org_acts_for_member(member_id)
         and public.can_see_signup(public.slot_signup(slot_id))
         and public.org_writable(public.signup_org(public.slot_signup(slot_id))))
  with check (public.org_acts_for_member(member_id)
         and public.can_see_signup(public.slot_signup(slot_id))
         and public.org_writable(public.signup_org(public.slot_signup(slot_id))));
create policy signup_claim_staff on public.org_signup_claims for all to authenticated
  using (public.org_can_write(public.signup_org(public.slot_signup(slot_id)), 'signup.manage'))
  with check (public.org_can_write(public.signup_org(public.slot_signup(slot_id)), 'signup.manage'));

-- ── tasks: readable org-wide; managed by task.manage; assignees may move
--    their own task along the board (the UPDATE check keeps them in-org).
create policy task_read on public.org_tasks for select to authenticated
  using (public.is_org_member(org_id));
create policy task_write on public.org_tasks for all to authenticated
  using (public.org_can_write(org_id, 'task.manage'))
  with check (public.org_can_write(org_id, 'task.manage'));
create policy task_assignee_update on public.org_tasks for update to authenticated
  using (public.is_task_assignee(id) and public.org_writable(org_id))
  with check (public.is_task_assignee(id) and public.org_writable(org_id));

create policy task_assignee_read on public.org_task_assignees for select to authenticated
  using (exists (select 1 from public.org_tasks t
                  where t.id = task_id and public.is_org_member(t.org_id)));
create policy task_assignee_write on public.org_task_assignees for all to authenticated
  using (exists (select 1 from public.org_tasks t
                  where t.id = task_id and public.org_can_write(t.org_id, 'task.manage')))
  with check (exists (select 1 from public.org_tasks t
                  where t.id = task_id and public.org_can_write(t.org_id, 'task.manage')));

-- ── polls
create policy poll_read on public.org_polls for select to authenticated
  using (public.is_org_member(org_id));
create policy poll_write on public.org_polls for all to authenticated
  using (public.org_can_write(org_id, 'poll.manage'))
  with check (public.org_can_write(org_id, 'poll.manage'));

create policy poll_option_read on public.org_poll_options for select to authenticated
  using (exists (select 1 from public.org_polls p
                  where p.id = poll_id and public.is_org_member(p.org_id)));
create policy poll_option_write on public.org_poll_options for all to authenticated
  using (exists (select 1 from public.org_polls p
                  where p.id = poll_id and public.org_can_write(p.org_id, 'poll.manage')))
  with check (exists (select 1 from public.org_polls p
                  where p.id = poll_id and public.org_can_write(p.org_id, 'poll.manage')));

-- votes: always your own. Other people's rows only when the poll is not
-- anonymous AND results are visible to you. Anonymous tallies come from
-- org_poll_results() instead, which never returns who voted for what.
create policy poll_vote_read on public.org_poll_votes for select to authenticated
  using (
    public.org_acts_for_member(member_id)
    or (public.poll_results_visible(poll_id)
        and exists (select 1 from public.org_polls p
                     where p.id = poll_id and not p.anonymous))
  );
create policy poll_vote_self on public.org_poll_votes for all to authenticated
  using (public.org_acts_for_member(member_id)
         and exists (select 1 from public.org_polls p
                      where p.id = poll_id and public.org_writable(p.org_id)))
  with check (public.org_acts_for_member(member_id)
         and exists (select 1 from public.org_polls p
                      where p.id = poll_id and public.org_writable(p.org_id)
                        and (p.closes_at is null or p.closes_at > now())));
create policy poll_vote_staff on public.org_poll_votes for delete to authenticated
  using (exists (select 1 from public.org_polls p
                  where p.id = poll_id and public.org_can_write(p.org_id, 'poll.manage')));


-- ═══════════════════════════════════════════════════════════════════════
-- RPCs — the operations that must be atomic or must not be expressible as
-- a plain table write from the browser.
-- ═══════════════════════════════════════════════════════════════════════

-- ── RSVP (mine, or my student's). One call, no client-side member lookup.
create or replace function public.org_rsvp_set(
  p_event uuid, p_response text, p_member uuid default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_member uuid;
begin
  select org_id into v_org from public.org_events where id = p_event;
  if v_org is null then raise exception 'event_not_found'; end if;
  if not public.can_see_event(p_event) then raise exception 'not_permitted'; end if;
  if not public.org_writable(v_org) then raise exception 'workspace_read_only'; end if;
  v_member := coalesce(p_member, public.org_member_id(v_org));
  if v_member is null then raise exception 'not_a_member'; end if;
  if not public.org_acts_for_member(v_member) then raise exception 'not_permitted'; end if;
  if p_response not in ('yes', 'no', 'maybe') then raise exception 'bad_response'; end if;

  insert into public.org_event_rsvps (event_id, member_id, response, note, responded_by_user, responded_at)
  values (p_event, v_member, p_response, p_note, auth.uid(), now())
  on conflict (event_id, member_id) do update
    set response = excluded.response, note = excluded.note,
        responded_by_user = excluded.responded_by_user, responded_at = now();
end $$;

-- ── attendance: the whole grid in one request. Rows are
--    [{"member_id":"…","status":"present","note":null}, …]
create or replace function public.org_attendance_save(p_event uuid, p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_by uuid;
  v_n int := 0;
begin
  select org_id into v_org from public.org_events where id = p_event;
  if v_org is null then raise exception 'event_not_found'; end if;
  if not public.org_can_write(v_org, 'attendance.edit') then raise exception 'not_permitted'; end if;
  v_by := public.org_member_id(v_org);

  insert into public.org_attendance (event_id, member_id, status, note, recorded_by_member, recorded_at)
  select p_event,
         (r->>'member_id')::uuid,
         r->>'status',
         nullif(r->>'note', ''),
         v_by,
         now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
   where r->>'status' in ('present', 'absent', 'late', 'excused', 'left_early')
     and exists (select 1 from public.org_members m
                  where m.id = (r->>'member_id')::uuid and m.org_id = v_org)
  on conflict (event_id, member_id) do update
    set status = excluded.status,
        note = coalesce(excluded.note, org_attendance.note),
        recorded_by_member = excluded.recorded_by_member,
        recorded_at = now();

  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ── a member (or their guardian) explaining an absence. Touches the note
--    only — never the status, which is why this isn't a table policy.
create or replace function public.org_attendance_self_note(
  p_event uuid, p_note text, p_member uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_member uuid;
begin
  select org_id into v_org from public.org_events where id = p_event;
  if v_org is null then raise exception 'event_not_found'; end if;
  if not public.org_writable(v_org) then raise exception 'workspace_read_only'; end if;
  v_member := coalesce(p_member, public.org_member_id(v_org));
  if v_member is null or not public.org_acts_for_member(v_member) then
    raise exception 'not_permitted';
  end if;

  -- If staff have already marked this member, only the note changes. If they
  -- haven't, the row starts as 'absent' — a member cannot excuse themselves;
  -- staff move it to 'excused' once they accept the reason.
  insert into public.org_attendance (event_id, member_id, status, note)
  values (p_event, v_member, 'absent', p_note)
  on conflict (event_id, member_id) do update set note = excluded.note;
end $$;

-- ── claiming a signup slot: capacity and waitlist decided server-side, so
--    two parents tapping at once can't both take the last chaperone spot.
--    Returns true when confirmed, false when waitlisted.
create or replace function public.org_signup_claim(p_slot uuid, p_note text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_signup uuid;
  v_org uuid;
  v_member uuid;
  v_cap int;
  v_taken int;
  v_wait boolean;
  v_closes timestamptz;
begin
  select s.id, s.org_id, s.closes_at, sl.capacity
    into v_signup, v_org, v_closes, v_cap
    from public.org_signup_slots sl
    join public.org_signups s on s.id = sl.signup_id
   where sl.id = p_slot
   for update of sl;
  if v_signup is null then raise exception 'slot_not_found'; end if;
  if not public.can_see_signup(v_signup) then raise exception 'not_permitted'; end if;
  if not public.org_writable(v_org) then raise exception 'workspace_read_only'; end if;
  if v_closes is not null and v_closes <= now() then raise exception 'signup_closed'; end if;

  v_member := public.org_member_id(v_org);
  if v_member is null then raise exception 'not_a_member'; end if;

  if exists (select 1 from public.org_signup_claims
              where slot_id = p_slot and member_id = v_member) then
    return not (select waitlisted from public.org_signup_claims
                 where slot_id = p_slot and member_id = v_member);
  end if;

  select count(*) into v_taken from public.org_signup_claims
   where slot_id = p_slot and not waitlisted;
  v_wait := (v_cap > 0 and v_taken >= v_cap);

  insert into public.org_signup_claims (slot_id, member_id, note, waitlisted)
  values (p_slot, v_member, p_note, v_wait);
  return not v_wait;
end $$;

-- ── releasing a slot promotes the first person off the waitlist
create or replace function public.org_signup_release(p_slot uuid, p_member uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_signup uuid;
  v_org uuid;
  v_member uuid;
  v_cap int;
  v_taken int;
  v_next uuid;
begin
  select s.id, s.org_id, sl.capacity into v_signup, v_org, v_cap
    from public.org_signup_slots sl
    join public.org_signups s on s.id = sl.signup_id
   where sl.id = p_slot
   for update of sl;
  if v_signup is null then raise exception 'slot_not_found'; end if;

  v_member := coalesce(p_member, public.org_member_id(v_org));
  if not (public.org_acts_for_member(v_member)
          or public.org_can_write(v_org, 'signup.manage')) then
    raise exception 'not_permitted';
  end if;

  delete from public.org_signup_claims where slot_id = p_slot and member_id = v_member;

  if v_cap > 0 then
    select count(*) into v_taken from public.org_signup_claims
     where slot_id = p_slot and not waitlisted;
    while v_taken < v_cap loop
      select member_id into v_next from public.org_signup_claims
       where slot_id = p_slot and waitlisted
       order by claimed_at limit 1;
      exit when v_next is null;
      update public.org_signup_claims set waitlisted = false
       where slot_id = p_slot and member_id = v_next;
      v_taken := v_taken + 1;
      v_next := null;
    end loop;
  end if;
end $$;

-- ── voting: replaces the member's whole ballot, enforces single vs multi
create or replace function public.org_poll_vote(p_poll uuid, p_options uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare
  p public.org_polls%rowtype;
  v_member uuid;
begin
  select * into p from public.org_polls where id = p_poll;
  if p.id is null then raise exception 'poll_not_found'; end if;
  if not public.is_org_member(p.org_id) then raise exception 'not_permitted'; end if;
  if not public.org_writable(p.org_id) then raise exception 'workspace_read_only'; end if;
  if p.closes_at is not null and p.closes_at <= now() then raise exception 'poll_closed'; end if;
  if p.kind = 'single' and coalesce(array_length(p_options, 1), 0) > 1 then
    raise exception 'single_choice_poll';
  end if;

  v_member := public.org_member_id(p.org_id);
  if v_member is null then raise exception 'not_a_member'; end if;

  delete from public.org_poll_votes where poll_id = p_poll and member_id = v_member;
  insert into public.org_poll_votes (poll_id, option_id, member_id)
  select p_poll, o.id, v_member
    from public.org_poll_options o
   where o.poll_id = p_poll and o.id = any(coalesce(p_options, '{}'::uuid[]));
end $$;

-- ── the tally. Safe for anonymous polls: counts only, never voters.
create or replace function public.org_poll_results(p_poll uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  v_org uuid;
  v_out jsonb;
begin
  select org_id into v_org from public.org_polls where id = p_poll;
  if v_org is null then raise exception 'poll_not_found'; end if;
  if not public.is_org_member(v_org) then raise exception 'not_permitted'; end if;
  if not public.poll_results_visible(p_poll) then raise exception 'results_hidden'; end if;

  select jsonb_build_object(
           'total', (select count(distinct member_id) from public.org_poll_votes where poll_id = p_poll),
           'options', coalesce(jsonb_agg(jsonb_build_object(
                        'id', o.id, 'label', o.label, 'votes', c.n) order by o.sort, o.label), '[]'::jsonb))
    into v_out
    from public.org_poll_options o
    left join lateral (
      select count(*)::int as n from public.org_poll_votes v where v.option_id = o.id
    ) c on true
   where o.poll_id = p_poll;
  return v_out;
end $$;

-- ── one-call event creation with its targets, so a half-created event can
--    never exist if the targets insert fails.
create or replace function public.org_event_create(p_event jsonb, p_groups uuid[] default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := (p_event->>'org_id')::uuid;
  v_id uuid;
begin
  if v_org is null then raise exception 'org_required'; end if;
  if not public.org_can_write(v_org, 'event.create') then raise exception 'not_permitted'; end if;

  insert into public.org_events (
    org_id, season_id, title, kind, starts_at, ends_at, all_day, location, address,
    description, attachments, rsvp_required, attendance_required,
    public_app_key, public_event_key, public_event_date, created_by_member)
  values (
    v_org,
    nullif(p_event->>'season_id', '')::uuid,
    coalesce(nullif(p_event->>'title', ''), 'Untitled event'),
    coalesce(nullif(p_event->>'kind', ''), 'rehearsal'),
    (p_event->>'starts_at')::timestamptz,
    nullif(p_event->>'ends_at', '')::timestamptz,
    coalesce((p_event->>'all_day')::boolean, false),
    nullif(p_event->>'location', ''),
    nullif(p_event->>'address', ''),
    nullif(p_event->>'description', ''),
    coalesce(p_event->'attachments', '[]'::jsonb),
    coalesce((p_event->>'rsvp_required')::boolean, false),
    coalesce((p_event->>'attendance_required')::boolean, false),
    p_event->>'public_app_key',
    nullif(p_event->>'public_event_key', ''),
    nullif(p_event->>'public_event_date', '')::date,
    public.org_member_id(v_org))
  returning id into v_id;

  insert into public.org_event_targets (event_id, group_id)
  select v_id, g.id from public.org_groups g
   where g.org_id = v_org and g.id = any(coalesce(p_groups, '{}'::uuid[]))
  on conflict do nothing;

  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (v_org, auth.uid(), 'event.created', 'event', v_id::text);
  return v_id;
end $$;

revoke execute on function public.org_rsvp_set(uuid, text, uuid, text) from public, anon;
revoke execute on function public.org_attendance_save(uuid, jsonb) from public, anon;
revoke execute on function public.org_attendance_self_note(uuid, text, uuid) from public, anon;
revoke execute on function public.org_signup_claim(uuid, text) from public, anon;
revoke execute on function public.org_signup_release(uuid, uuid) from public, anon;
revoke execute on function public.org_poll_vote(uuid, uuid[]) from public, anon;
revoke execute on function public.org_poll_results(uuid) from public, anon;
revoke execute on function public.org_event_create(jsonb, uuid[]) from public, anon;

grant execute on function public.org_rsvp_set(uuid, text, uuid, text) to authenticated;
grant execute on function public.org_attendance_save(uuid, jsonb) to authenticated;
grant execute on function public.org_attendance_self_note(uuid, text, uuid) to authenticated;
grant execute on function public.org_signup_claim(uuid, text) to authenticated;
grant execute on function public.org_signup_release(uuid, uuid) to authenticated;
grant execute on function public.org_poll_vote(uuid, uuid[]) to authenticated;
grant execute on function public.org_poll_results(uuid) to authenticated;
grant execute on function public.org_event_create(jsonb, uuid[]) to authenticated;


-- ═══ Owner workflow queries ════════════════════════════════════════════
-- Link an organization to its public Cadence identity (turns on the
-- competition bridge in docs/ensemble/ops.js):
--   update organizations
--      set public_app_key = 'boa', public_ensemble_name = 'Carmel HS (IN)'
--    where slug = '…';
--   -- public_app_key '' means the DCI app at the site root.
--
-- Events whose competition result should now be resolvable:
--   select title, public_app_key, public_event_key, public_event_date
--     from org_events
--    where public_event_key is not null and public_event_date < current_date;
--
-- Attendance rate for a season:
--   select e.title, count(*) filter (where a.status = 'present')::float
--          / nullif(count(*), 0) as rate
--     from org_events e join org_attendance a on a.event_id = e.id
--    where e.org_id = '…' group by e.id, e.title order by min(e.starts_at);


-- ───────────────────────────────────────────────
-- 0008_ensemble_files.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE ENSEMBLE — file storage & the music library (Phase 4)
--
-- Nested folders, per-folder access control, versioned files, tags, music
-- metadata (production / movement / instrument / section), favorites, a
-- private Storage bucket with RLS keyed on organization, and a running
-- storage-usage counter that feeds the quota bar in the UI.
--
-- ─── RIGHTS NOTICE ────────────────────────────────────────────────────
-- Cadence provides storage. ORGANIZATIONS ARE RESPONSIBLE FOR HOLDING THE
-- RIGHTS to any sheet music, arrangements, recordings, drill, photography
-- or other media they upload, and for the licences their members' use of
-- that material requires. Cadence does not review, clear, license or
-- redistribute uploaded material.
--
-- NOTHING UPLOADED IS EVER PUBLIC BY DEFAULT. The 'ensemble' bucket is
-- created private (public = false); every object is reachable only through
-- a short-lived signed URL minted for a signed-in member whose row-level
-- permissions allow reading the owning file. There is no code path in this
-- schema — and none in the client — that produces a public object URL.
-- ──────────────────────────────────────────────────────────────────────
--
-- ─── Owner: run this once in the Supabase SQL editor. ───
-- Depends on: 0001 (touch_updated_at), 0005 (organizations, org_members,
-- org_groups, org_roles, org_seasons and the is_org_member / org_has_perm /
-- org_can_write / org_member_id / is_group_member helpers).
--
-- If your SQL editor role does not own storage.objects, the final section
-- (bucket + storage policies) will error. See the notes there: create the
-- bucket in Dashboard → Storage (name 'ensemble', Public = OFF) and add the
-- four policies from Dashboard → Storage → Policies using the same
-- expressions; the helper functions themselves live in `public` and are
-- created successfully either way.
-- ═══════════════════════════════════════════════════════════════════════

-- ═══ tables ═══════════════════════════════════════════════════════════

-- ── folders (nestable: Season 2026 ▸ Music ▸ Brass ▸ Trumpet)
create table if not exists public.org_folders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  parent_id uuid references public.org_folders(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  kind text not null default 'general'
    check (kind in ('general', 'music', 'audio', 'video', 'visual',
                    'admin', 'travel', 'staff', 'booster')),
  season_id uuid references public.org_seasons(id) on delete set null,
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists org_folders_org_idx on public.org_folders (org_id);
create index if not exists org_folders_parent_idx on public.org_folders (parent_id);
-- one folder name per level (root treated as a fixed sentinel parent)
create unique index if not exists org_folders_unique_name
  on public.org_folders (org_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));

-- ── per-folder access. NO ROWS = every active member of the org may view.
--    A row grants view; can_upload additionally grants upload.
create table if not exists public.org_folder_access (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.org_folders(id) on delete cascade,
  group_id uuid references public.org_groups(id) on delete cascade,
  role_kind text
    check (role_kind in ('owner', 'staff', 'leadership', 'member', 'parent',
                         'booster', 'volunteer', 'alumni', 'guest')),
  can_upload boolean not null default false,
  created_at timestamptz not null default now(),
  -- a rule must name something
  constraint org_folder_access_target check (group_id is not null or role_kind is not null)
);
create index if not exists org_folder_access_folder_idx on public.org_folder_access (folder_id);
-- (partial indexes rather than a NULLS NOT DISTINCT unique — works on any PG)
create unique index if not exists org_folder_access_group_uniq
  on public.org_folder_access (folder_id, group_id) where group_id is not null;
create unique index if not exists org_folder_access_role_uniq
  on public.org_folder_access (folder_id, role_kind) where role_kind is not null;

-- ── files. storage_path is the object key inside the private 'ensemble'
--    bucket and is laid out as  <org_id>/<folder_id|root>/<uuid>_<name>
--    so the Storage policies can authorize an object without a join.
create table if not exists public.org_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  folder_id uuid references public.org_folders(id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 200),
  storage_path text not null unique,
  mime text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  tags text[] not null default '{}',
  version int not null default 1 check (version >= 1),
  replaces_file_id uuid references public.org_files(id) on delete set null,
  uploaded_by_member uuid references public.org_members(id) on delete set null,
  -- ── music-library metadata (all optional; a PDF part fills them all in)
  instrument text,        -- 'Trumpet 2'
  section text,           -- 'Brass'
  production text,        -- '2026 — "Meridian"'
  movement text,          -- 'Mvt. II — Drift'
  season_id uuid references public.org_seasons(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists org_files_org_idx on public.org_files (org_id, created_at desc);
create index if not exists org_files_folder_idx on public.org_files (folder_id);
create index if not exists org_files_tags_idx on public.org_files using gin (tags);
create index if not exists org_files_music_idx
  on public.org_files (org_id, production, movement, section, instrument);
create index if not exists org_files_replaces_idx on public.org_files (replaces_file_id);

drop trigger if exists org_files_touch on public.org_files;
create trigger org_files_touch before update on public.org_files
  for each row execute function public.touch_updated_at();

-- ── favorites ("my part", starred practice tracks)
create table if not exists public.org_file_favorites (
  file_id uuid not null references public.org_files(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (file_id, member_id)
);
create index if not exists org_file_favorites_member_idx on public.org_file_favorites (member_id);

-- ═══ access helpers (SECURITY DEFINER: they read membership/group tables
--     that the caller may not select directly, and they must not recurse
--     back into the policies that call them) ══════════════════════════

-- Can the caller SEE this folder?
--   • must be an active member of the folder's org
--   • every folder on the path from this folder up to the root that carries
--     access rows must match the caller (by group membership or role kind).
--     A folder with no access rows is open to the whole org.
--   • 'file.manage' holders always see everything (they administer it)
create or replace function public.can_see_folder(p_folder uuid)
returns boolean language plpgsql security definer stable set search_path = public as $$
declare
  f public.org_folders%rowtype;
  cur uuid := p_folder;
  hops int := 0;
  matched boolean;
begin
  if p_folder is null then return false; end if;
  select * into f from public.org_folders where id = p_folder;
  if not found then return false; end if;
  if not public.is_org_member(f.org_id) then return false; end if;
  if public.org_has_perm(f.org_id, 'file.manage') then return true; end if;

  while cur is not null and hops < 12 loop
    select * into f from public.org_folders where id = cur;
    exit when not found;
    if exists (select 1 from public.org_folder_access a where a.folder_id = f.id) then
      select exists (
        select 1 from public.org_folder_access a
         where a.folder_id = f.id
           and (
             (a.group_id is not null and public.is_group_member(a.group_id))
             or (a.role_kind is not null and exists (
                   select 1 from public.org_members m
                     join public.org_roles r on r.id = m.role_id
                    where m.org_id = f.org_id and m.user_id = auth.uid()
                      and m.status = 'active' and r.kind = a.role_kind))
           )
      ) into matched;
      if not matched then return false; end if;
    end if;
    cur := f.parent_id;
    hops := hops + 1;
  end loop;
  return true;
end $$;

-- Can the caller UPLOAD into this folder?
--   sight of the folder + 'file.upload' + a writable subscription, and when
--   the folder carries access rules, a matching rule with can_upload.
create or replace function public.can_upload_folder(p_folder uuid)
returns boolean language plpgsql security definer stable set search_path = public as $$
declare
  f public.org_folders%rowtype;
  matched boolean;
begin
  if p_folder is null then return false; end if;
  select * into f from public.org_folders where id = p_folder;
  if not found then return false; end if;
  if not public.can_see_folder(p_folder) then return false; end if;
  if public.org_can_write(f.org_id, 'file.manage') then return true; end if;
  if not public.org_can_write(f.org_id, 'file.upload') then return false; end if;
  if not exists (select 1 from public.org_folder_access a where a.folder_id = f.id) then
    return true;
  end if;
  select exists (
    select 1 from public.org_folder_access a
     where a.folder_id = f.id and a.can_upload
       and (
         (a.group_id is not null and public.is_group_member(a.group_id))
         or (a.role_kind is not null and exists (
               select 1 from public.org_members m
                 join public.org_roles r on r.id = m.role_id
                where m.org_id = f.org_id and m.user_id = auth.uid()
                  and m.status = 'active' and r.kind = a.role_kind))
       )
  ) into matched;
  return matched;
end $$;

revoke execute on function public.can_see_folder(uuid) from public, anon;
revoke execute on function public.can_upload_folder(uuid) from public, anon;
grant execute on function public.can_see_folder(uuid) to authenticated;
grant execute on function public.can_upload_folder(uuid) to authenticated;

-- ═══ storage accounting ═══════════════════════════════════════════════

-- keeps organizations.storage_used_bytes truthful without the client ever
-- being trusted to report it
create or replace function public.bump_org_storage()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.organizations
       set storage_used_bytes = greatest(0, storage_used_bytes + coalesce(new.size_bytes, 0))
     where id = new.org_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.organizations
       set storage_used_bytes = greatest(0, storage_used_bytes - coalesce(old.size_bytes, 0))
     where id = old.org_id;
    return old;
  else
    if coalesce(new.size_bytes, 0) <> coalesce(old.size_bytes, 0) or new.org_id <> old.org_id then
      update public.organizations
         set storage_used_bytes = greatest(0, storage_used_bytes - coalesce(old.size_bytes, 0))
       where id = old.org_id;
      update public.organizations
         set storage_used_bytes = greatest(0, storage_used_bytes + coalesce(new.size_bytes, 0))
       where id = new.org_id;
    end if;
    return new;
  end if;
end $$;

drop trigger if exists org_files_storage_usage on public.org_files;
create trigger org_files_storage_usage
  after insert or update of size_bytes, org_id or delete on public.org_files
  for each row execute function public.bump_org_storage();

-- the quota is enforced here, not in the browser: a workspace at its limit
-- cannot record new files no matter what the client sends. Downloads and
-- reads are never affected.
create or replace function public.enforce_org_storage_quota()
returns trigger language plpgsql security definer set search_path = public as $$
declare o public.organizations%rowtype;
begin
  select * into o from public.organizations where id = new.org_id;
  if not found then raise exception 'unknown_org'; end if;
  if o.storage_used_bytes + coalesce(new.size_bytes, 0) > o.storage_quota_bytes then
    raise exception 'storage_quota_exceeded'
      using hint = 'This workspace is out of storage. Remove files or upgrade the plan.';
  end if;
  return new;
end $$;

drop trigger if exists org_files_quota on public.org_files;
create trigger org_files_quota before insert on public.org_files
  for each row execute function public.enforce_org_storage_quota();

-- A folder's access rules are what protect the files inside it. Deleting a
-- folder would set its files' folder_id to null, which makes them readable
-- by the whole workspace — so a folder must be emptied first, on purpose.
create or replace function public.guard_folder_delete()
returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from public.org_folders c where c.parent_id = old.id) then
    raise exception 'folder_not_empty'
      using hint = 'Move or delete the sub-folders inside it first.';
  end if;
  if exists (select 1 from public.org_files f where f.folder_id = old.id) then
    raise exception 'folder_not_empty'
      using hint = 'Move or delete the files inside it first.';
  end if;
  return old;
end $$;

drop trigger if exists org_folders_guard_delete on public.org_folders;
create trigger org_folders_guard_delete before delete on public.org_folders
  for each row execute function public.guard_folder_delete();

-- owner utility: recompute a workspace's usage from the file rows
create or replace function public.recount_org_storage(p_org uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare total bigint;
begin
  select coalesce(sum(size_bytes), 0) into total from public.org_files where org_id = p_org;
  update public.organizations set storage_used_bytes = total where id = p_org;
  return total;
end $$;
revoke execute on function public.recount_org_storage(uuid) from public, anon, authenticated;

-- ═══ RLS ══════════════════════════════════════════════════════════════
alter table public.org_folders enable row level security;
alter table public.org_folder_access enable row level security;
alter table public.org_files enable row level security;
alter table public.org_file_favorites enable row level security;

-- folders: see what you're allowed to see; make sub-folders where you may
-- upload; renaming/moving/deleting is a 'file.manage' job.
drop policy if exists folders_read on public.org_folders;
create policy folders_read on public.org_folders for select to authenticated
  using (public.can_see_folder(id));
drop policy if exists folders_insert on public.org_folders;
create policy folders_insert on public.org_folders for insert to authenticated
  with check (
    public.org_can_write(org_id, 'file.upload')
    and (parent_id is null or public.can_upload_folder(parent_id))
  );
drop policy if exists folders_update on public.org_folders;
create policy folders_update on public.org_folders for update to authenticated
  using (public.org_can_write(org_id, 'file.manage'))
  with check (public.org_can_write(org_id, 'file.manage'));
drop policy if exists folders_delete on public.org_folders;
create policy folders_delete on public.org_folders for delete to authenticated
  using (public.org_can_write(org_id, 'file.manage'));

-- folder access rules: visible to anyone who can see the folder, editable
-- only by 'file.manage'
drop policy if exists folder_access_read on public.org_folder_access;
create policy folder_access_read on public.org_folder_access for select to authenticated
  using (public.can_see_folder(folder_id));
drop policy if exists folder_access_write on public.org_folder_access;
create policy folder_access_write on public.org_folder_access for all to authenticated
  using (exists (select 1 from public.org_folders f
                  where f.id = folder_id and public.org_can_write(f.org_id, 'file.manage')))
  with check (exists (select 1 from public.org_folders f
                  where f.id = folder_id and public.org_can_write(f.org_id, 'file.manage')));

-- files: readable when the folder is visible (root-level files are visible
-- to the whole org); uploadable with 'file.upload' into a folder you may
-- upload to, attributed to your own member row; rename/delete = 'file.manage'
drop policy if exists files_read on public.org_files;
create policy files_read on public.org_files for select to authenticated
  using (
    public.is_org_member(org_id)
    and (folder_id is null or public.can_see_folder(folder_id))
  );
drop policy if exists files_insert on public.org_files;
create policy files_insert on public.org_files for insert to authenticated
  with check (
    public.org_can_write(org_id, 'file.upload')
    and (folder_id is null or public.can_upload_folder(folder_id))
    and uploaded_by_member = public.org_member_id(org_id)
  );
drop policy if exists files_update on public.org_files;
create policy files_update on public.org_files for update to authenticated
  using (public.org_can_write(org_id, 'file.manage'))
  with check (public.org_can_write(org_id, 'file.manage'));
drop policy if exists files_delete on public.org_files;
create policy files_delete on public.org_files for delete to authenticated
  using (public.org_can_write(org_id, 'file.manage'));

-- favorites: strictly your own, and only on files you can already read
-- (org_files' own RLS applies inside this subquery)
drop policy if exists favs_own on public.org_file_favorites;
create policy favs_own on public.org_file_favorites for all to authenticated
  using (exists (select 1 from public.org_files f
                  where f.id = file_id and member_id = public.org_member_id(f.org_id)))
  with check (exists (select 1 from public.org_files f
                  where f.id = file_id and member_id = public.org_member_id(f.org_id)));

-- ═══════════════════════════════════════════════════════════════════════
-- STORAGE: the private 'ensemble' bucket
--
-- Object keys are  <org_id>/<folder_id|'root'>/<uuid>_<filename>
-- so every authorization decision is derivable from the key itself:
--   (storage.foldername(name))[1]::uuid = the owning organization
--   (storage.foldername(name))[2]::uuid = the owning folder ('root' = none)
--
-- public = false. Nothing here ever mints a public URL; the client asks for
-- a short-lived signed URL per download/preview.
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit)
  values ('ensemble', 'ensemble', false, 524288000)   -- 500 MB per object
  on conflict (id) do nothing;
exception when insufficient_privilege or undefined_table then
  raise notice 'Cadence: could not create the ensemble storage bucket from SQL — create it in Dashboard → Storage (name: ensemble, Public: OFF).';
end $$;

-- path parsers. They do exactly (storage.foldername(name))[n]::uuid, but
-- return null instead of raising when a key is malformed or the segment is
-- the literal 'root' — a policy that raises would 500 instead of denying.
create or replace function public.ensemble_path_org(p_name text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return (storage.foldername(p_name))[1]::uuid;
exception when others then return null;
end $$;

create or replace function public.ensemble_path_folder(p_name text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return (storage.foldername(p_name))[2]::uuid;
exception when others then return null;
end $$;

-- READ: you must be a member of the org named by the key, and you must be
-- able to read the org_files row that owns the object. Objects with no file
-- row yet (an upload mid-flight, or an orphan) are visible only to people
-- who could have uploaded them.
create or replace function public.can_read_ensemble_object(p_name text)
returns boolean language plpgsql security definer stable set search_path = public as $$
declare
  org uuid := public.ensemble_path_org(p_name);
  f public.org_files%rowtype;
begin
  if org is null then return false; end if;
  if not public.is_org_member(org) then return false; end if;
  select * into f from public.org_files where storage_path = p_name;
  if found then
    if f.org_id <> org then return false; end if;
    return f.folder_id is null or public.can_see_folder(f.folder_id);
  end if;
  -- no row: uploaders and managers only
  return public.org_has_perm(org, 'file.manage') or public.org_can_write(org, 'file.upload');
end $$;

-- WRITE: member of the org in the key, holds 'file.upload' on a writable
-- workspace, and — when the key names a folder — may upload into it.
create or replace function public.can_write_ensemble_object(p_name text)
returns boolean language plpgsql security definer stable set search_path = public as $$
declare
  org uuid := public.ensemble_path_org(p_name);
  fol uuid := public.ensemble_path_folder(p_name);
begin
  if org is null then return false; end if;
  if not public.is_org_member(org) then return false; end if;
  if not public.org_can_write(org, 'file.upload') then return false; end if;
  if fol is null then return true; end if;   -- root of the workspace
  return exists (select 1 from public.org_folders f where f.id = fol and f.org_id = org)
         and public.can_upload_folder(fol);
end $$;

-- DELETE: 'file.manage', or the uploader clearing up an orphan object that
-- never got a file row (a failed upload).
create or replace function public.can_delete_ensemble_object(p_name text)
returns boolean language plpgsql security definer stable set search_path = public as $$
declare
  org uuid := public.ensemble_path_org(p_name);
begin
  if org is null then return false; end if;
  if public.org_can_write(org, 'file.manage') then return true; end if;
  return not exists (select 1 from public.org_files where storage_path = p_name)
         and public.org_can_write(org, 'file.upload');
end $$;

revoke execute on function public.ensemble_path_org(text) from public, anon;
revoke execute on function public.ensemble_path_folder(text) from public, anon;
revoke execute on function public.can_read_ensemble_object(text) from public, anon;
revoke execute on function public.can_write_ensemble_object(text) from public, anon;
revoke execute on function public.can_delete_ensemble_object(text) from public, anon;
grant execute on function public.ensemble_path_org(text) to authenticated;
grant execute on function public.ensemble_path_folder(text) to authenticated;
grant execute on function public.can_read_ensemble_object(text) to authenticated;
grant execute on function public.can_write_ensemble_object(text) to authenticated;
grant execute on function public.can_delete_ensemble_object(text) to authenticated;

-- ── policies on storage.objects ───────────────────────────────────────
-- Supabase hosts storage.objects under a role the SQL editor usually cannot
-- alter, so these statements are attempted and skipped rather than allowed to
-- abort the whole migration. If they are skipped, finish in the dashboard:
--   Storage → Policies → bucket `ensemble` → New policy → For full
--   customization, and create four policies for role `authenticated` using
--   the same expressions shown below. The helper functions they call are
--   already created above, so it is pure copy-paste.
do $$
begin
  execute 'alter table storage.objects enable row level security';

  execute 'drop policy if exists ensemble_objects_read on storage.objects';
  execute $p$create policy ensemble_objects_read on storage.objects for select to authenticated
    using (bucket_id = 'ensemble' and public.can_read_ensemble_object(name))$p$;

  execute 'drop policy if exists ensemble_objects_insert on storage.objects';
  execute $p$create policy ensemble_objects_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'ensemble' and public.can_write_ensemble_object(name))$p$;

  execute 'drop policy if exists ensemble_objects_update on storage.objects';
  execute $p$create policy ensemble_objects_update on storage.objects for update to authenticated
    using (bucket_id = 'ensemble' and public.can_write_ensemble_object(name))
    with check (bucket_id = 'ensemble' and public.can_write_ensemble_object(name))$p$;

  execute 'drop policy if exists ensemble_objects_delete on storage.objects';
  execute $p$create policy ensemble_objects_delete on storage.objects for delete to authenticated
    using (bucket_id = 'ensemble' and public.can_delete_ensemble_object(name))$p$;

  raise notice 'Cadence: storage.objects policies applied.';
exception
  when insufficient_privilege or undefined_table then
    raise notice 'Cadence: could not alter storage.objects from the SQL editor (%). Everything else applied — finish the four file-access policies in Dashboard → Storage → Policies. Until then, file uploads/downloads stay locked.', sqlerrm;
end $$;

-- ═══ Owner workflow queries ═══════════════════════════════════════════
-- Confirm the bucket is private (this must print f):
--   select id, public from storage.buckets where id = 'ensemble';
--
-- Largest files in a workspace:
--   select name, size_bytes, created_at from org_files
--    where org_id = '<uuid>' order by size_bytes desc limit 25;
--
-- Re-sync a workspace's usage counter after manual cleanup:
--   select public.recount_org_storage('<org uuid>');
--
-- Find storage objects with no file row (failed uploads) older than a day:
--   select o.name, o.created_at from storage.objects o
--    left join public.org_files f on f.storage_path = o.name
--    where o.bucket_id = 'ensemble' and f.id is null
--      and o.created_at < now() - interval '1 day';
--
-- Raise a paid workspace's quota (25 GB):
--   update organizations set storage_quota_bytes = 26843545600 where slug = '…';


-- ───────────────────────────────────────────────
-- 0009_ensemble_people.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE ENSEMBLE — people, forms & organization billing (Phases 5, 7, 8)
--
-- Three things a real band program cannot run without:
--
--   1. PEOPLE — parents/guardians linked to the students they belong to, so
--      a guardian sees their own child's information and nothing else.
--   2. FORMS — medical, travel, sizing, volunteer, audition and survey
--      forms. Medical data is the most sensitive thing this product will
--      ever hold: a form marked `is_sensitive` is readable only by staff
--      who hold BOTH 'form.manage' AND 'student.info', plus the submitter
--      and that submitter's guardians. Never widen this.
--   3. ORGANIZATION BILLING — the org pays once, members join free. Schools
--      rarely pay by card, so there is a purchase-order path: a billing
--      contact record and an invoice the owner issues and marks paid.
--
-- Billing tables deliberately use org_has_perm(), NOT org_can_write():
-- a read_only / expired workspace must still be able to reach billing —
-- that is how it gets reactivated. Trial expiry NEVER deletes data.
--
-- ─── Owner: run this once in the Supabase SQL editor. ───
-- Depends on: 0004 (touch_updated_at) and 0005 (organizations, org_members,
-- org_roles, org_groups,
-- org_group_members, helper functions is_org_member / org_has_perm /
-- org_can_write / org_writable / org_member_id).
-- Idempotent where it must be: org_guardians may also be created by the
-- calendar migration, so it is created with `if not exists` and identical
-- columns, and its policies are dropped-then-created.
-- ═══════════════════════════════════════════════════════════════════════

-- ═══ 1. GUARDIANS ═══════════════════════════════════════════════════════
-- Many-to-many in both directions: a student may have several guardians,
-- and a guardian may have several students in the program. Both rows are
-- org_members in the SAME org — a guardian is a member with the 'parent'
-- role, not a separate account type.
create table if not exists public.org_guardians (
  guardian_member_id uuid not null references public.org_members(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  primary key (guardian_member_id, member_id)
);
-- optional descriptive columns (added separately so a concurrently-created
-- table with the base columns still ends up complete)
alter table public.org_guardians add column if not exists relationship text;
alter table public.org_guardians add column if not exists is_primary boolean not null default false;
alter table public.org_guardians add column if not exists created_at timestamptz not null default now();

create index if not exists org_guardians_member_idx on public.org_guardians (member_id);
create index if not exists org_guardians_org_idx on public.org_guardians (org_id);

-- am I a guardian of this member?
create or replace function public.is_guardian_of(p_member uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_guardians g
      join public.org_members gm on gm.id = g.guardian_member_id
     where g.member_id = p_member
       and gm.user_id = auth.uid() and gm.status = 'active'
  )
$$;

-- the member ids of the students I am a guardian of, in one org
create or replace function public.my_student_member_ids(p_org uuid)
returns setof uuid language sql security definer stable set search_path = public as $$
  select g.member_id from public.org_guardians g
    join public.org_members gm on gm.id = g.guardian_member_id
   where g.org_id = p_org and gm.user_id = auth.uid() and gm.status = 'active'
$$;

revoke execute on function public.is_guardian_of(uuid) from public, anon;
revoke execute on function public.my_student_member_ids(uuid) from public, anon;

alter table public.org_guardians enable row level security;

-- Guardian links are roster metadata: any member of the org may see that a
-- link exists (the directory shows "Guardian: …"), but only member.manage /
-- parent.info staff may create or break one. Contact DETAILS stay behind
-- org_member_contacts' stricter policy from 0005 — this table leaks nothing
-- beyond the fact of the relationship.
drop policy if exists guardians_read on public.org_guardians;
create policy guardians_read on public.org_guardians for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists guardians_write on public.org_guardians;
create policy guardians_write on public.org_guardians for all to authenticated
  using (public.org_can_write(org_id, 'member.manage'))
  with check (public.org_can_write(org_id, 'member.manage'));

-- ═══ 2. FORMS ═══════════════════════════════════════════════════════════
create table public.org_forms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  description text,
  kind text not null default 'general'
    check (kind in ('general', 'medical', 'travel', 'sizing', 'volunteer',
                    'audition', 'survey')),
  -- empty array = everyone in the org; otherwise only these groups (and the
  -- guardians of members in these groups) see the form
  target_group_ids uuid[] not null default '{}',
  -- medical / anything with protected information: reads narrow to
  -- 'student.info' holders. Medical forms default to sensitive in the UI.
  is_sensitive boolean not null default false,
  is_open boolean not null default true,
  closes_at timestamptz,
  season_id uuid references public.org_seasons(id) on delete set null,
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index org_forms_org_idx on public.org_forms (org_id, created_at desc);

create table public.org_form_fields (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.org_forms(id) on delete cascade,
  label text not null,
  help text,
  field_type text not null default 'text'
    check (field_type in ('text', 'longtext', 'number', 'date', 'select',
                          'multiselect', 'checkbox', 'file', 'signature')),
  options text[] not null default '{}',
  required boolean not null default false,
  sort int not null default 100
);
create index org_form_fields_form_idx on public.org_form_fields (form_id, sort);

create table public.org_form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.org_forms(id) on delete cascade,
  -- org_id is denormalized so RLS can be evaluated without reading org_forms
  -- under the caller's own policies. It is FORCED by a trigger below, so a
  -- client cannot point a submission at an org it doesn't belong to.
  org_id uuid not null references public.organizations(id) on delete cascade,
  member_id uuid references public.org_members(id) on delete set null,
  submitted_by_user uuid references auth.users(id) on delete set null,
  data jsonb not null default '{}',
  files jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (form_id, member_id)
);
create index org_form_subs_form_idx on public.org_form_submissions (form_id, created_at desc);
create index org_form_subs_member_idx on public.org_form_submissions (member_id);

-- ── SECURITY DEFINER helpers. Policies must not read org_forms directly:
--    that would evaluate org_forms' own policies and can hide rows the
--    policy needs to see. These run as the table owner instead.
create or replace function public.org_form_org(p_form uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select f.org_id from public.org_forms f where f.id = p_form
$$;

create or replace function public.org_form_sensitive(p_form uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select f.is_sensitive from public.org_forms f where f.id = p_form), true)
$$;

-- may the caller SEE this form at all? (targeting + guardians + managers)
create or replace function public.org_form_visible(p_form uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_forms f
     where f.id = p_form
       and public.is_org_member(f.org_id)
       and (
         public.org_has_perm(f.org_id, 'form.manage')
         or cardinality(f.target_group_ids) = 0
         or exists (
           select 1 from public.org_group_members gm
             join public.org_members m on m.id = gm.member_id
            where m.user_id = auth.uid() and m.org_id = f.org_id and m.status = 'active'
              and gm.group_id = any (f.target_group_ids))
         or exists (   -- a guardian sees the forms aimed at their student
           select 1 from public.org_group_members gm
            where gm.member_id in (select public.my_student_member_ids(f.org_id))
              and gm.group_id = any (f.target_group_ids))
       )
  )
$$;

-- may the caller READ this submission? (submitter, their guardians, staff)
create or replace function public.org_submission_readable(p_form uuid, p_member uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select
    p_user = auth.uid()
    or (p_member is not null and p_member = public.org_member_id(public.org_form_org(p_form)))
    or (p_member is not null and public.is_guardian_of(p_member))
    or (
      public.org_has_perm(public.org_form_org(p_form), 'form.manage')
      and (
        not public.org_form_sensitive(p_form)
        -- SENSITIVE (medical, protected): student.info is also required
        or public.org_has_perm(public.org_form_org(p_form), 'student.info')
      )
    )
$$;

revoke execute on function public.org_form_org(uuid) from public, anon;
revoke execute on function public.org_form_sensitive(uuid) from public, anon;
revoke execute on function public.org_form_visible(uuid) from public, anon;
revoke execute on function public.org_submission_readable(uuid, uuid, uuid) from public, anon;

-- force org_id + submitted_by_user server-side; never trust the client
create or replace function public.stamp_form_submission()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.org_id := public.org_form_org(new.form_id);
  if new.org_id is null then raise exception 'form_not_found'; end if;
  if tg_op = 'INSERT' then
    new.submitted_by_user := coalesce(auth.uid(), new.submitted_by_user);
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger org_form_submissions_stamp
  before insert or update on public.org_form_submissions
  for each row execute function public.stamp_form_submission();

create trigger org_forms_touch before update on public.org_forms
  for each row execute function public.touch_updated_at();

alter table public.org_forms enable row level security;
alter table public.org_form_fields enable row level security;
alter table public.org_form_submissions enable row level security;

create policy forms_read on public.org_forms for select to authenticated
  using (public.org_form_visible(id));
create policy forms_write on public.org_forms for all to authenticated
  using (public.org_can_write(org_id, 'form.manage'))
  with check (public.org_can_write(org_id, 'form.manage'));

create policy form_fields_read on public.org_form_fields for select to authenticated
  using (public.org_form_visible(form_id));
create policy form_fields_write on public.org_form_fields for all to authenticated
  using (public.org_can_write(public.org_form_org(form_id), 'form.manage'))
  with check (public.org_can_write(public.org_form_org(form_id), 'form.manage'));

-- Submissions: the heart of the medical-privacy rule.
create policy form_subs_read on public.org_form_submissions for select to authenticated
  using (public.org_submission_readable(form_id, member_id, submitted_by_user));

-- Submit for yourself, or for a student you are the guardian of; managers
-- may record a submission on someone's behalf (paper form typed in).
create policy form_subs_insert on public.org_form_submissions for insert to authenticated
  with check (
    public.org_writable(public.org_form_org(form_id))
    and public.org_form_visible(form_id)
    and (
      member_id = public.org_member_id(public.org_form_org(form_id))
      or (member_id is not null and public.is_guardian_of(member_id))
      or public.org_has_perm(public.org_form_org(form_id), 'form.manage')
    )
  );

create policy form_subs_update on public.org_form_submissions for update to authenticated
  using (
    public.org_writable(org_id)
    and (
      member_id = public.org_member_id(org_id)
      or (member_id is not null and public.is_guardian_of(member_id))
      or public.org_can_write(org_id, 'form.manage')
    )
  )
  with check (
    member_id = public.org_member_id(org_id)
    or (member_id is not null and public.is_guardian_of(member_id))
    or public.org_can_write(org_id, 'form.manage')
  );

create policy form_subs_delete on public.org_form_submissions for delete to authenticated
  using (public.org_can_write(org_id, 'form.manage'));

-- ═══ 3. ORGANIZATION BILLING ════════════════════════════════════════════
-- One subscription covers the whole organization. Members never pay.
-- No card is charged anywhere in this schema — these rows record what the
-- school agreed to and what the owner issued. Stripe fields on
-- organizations (stripe_customer_id) stay authoritative for card billing.

create table public.org_billing_contacts (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  legal_name text,             -- 'Westfield High School Band Boosters, Inc.'
  contact_name text,
  contact_email text,
  contact_phone text,
  address text,
  po_number text,              -- the district's purchase order number
  tax_exempt_id text,
  notes text,
  updated_at timestamptz not null default now()
);

create table public.org_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  number text,                 -- 'CAD-2026-0007' — assigned when issued
  amount_cents bigint not null default 0,
  currency text not null default 'usd',
  status text not null default 'requested'
    check (status in ('requested', 'sent', 'paid', 'void')),
  plan text check (plan in ('trial', 'ensemble', 'pro', 'program', 'none')),
  period_start date,
  period_end date,
  due_on date,
  issued_at timestamptz,
  paid_at timestamptz,
  note text,
  requested_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, number)
);
create index org_invoices_org_idx on public.org_invoices (org_id, created_at desc);

create trigger org_billing_contacts_touch before update on public.org_billing_contacts
  for each row execute function public.touch_updated_at();

alter table public.org_billing_contacts enable row level security;
alter table public.org_invoices enable row level security;

-- NOTE: org_has_perm, not org_can_write — a read_only or expired workspace
-- must still reach billing, otherwise it can never be reactivated.
create policy billing_contacts_rw on public.org_billing_contacts for all to authenticated
  using (public.org_has_perm(org_id, 'billing.manage'))
  with check (public.org_has_perm(org_id, 'billing.manage'));

create policy invoices_read on public.org_invoices for select to authenticated
  using (public.org_has_perm(org_id, 'billing.manage'));

-- A workspace may REQUEST an invoice. Issuing, numbering and marking paid
-- are owner-side actions (service role / SQL editor) — nothing in the
-- browser may declare an invoice paid.
create policy invoices_request on public.org_invoices for insert to authenticated
  with check (
    public.org_has_perm(org_id, 'billing.manage')
    and status = 'requested'
    and paid_at is null and issued_at is null and number is null
  );

create policy invoices_cancel_request on public.org_invoices for update to authenticated
  using (public.org_has_perm(org_id, 'billing.manage') and status = 'requested')
  with check (public.org_has_perm(org_id, 'billing.manage') and status in ('requested', 'void'));

-- ═══ Owner workflow queries ═════════════════════════════════════════════
--
-- ── Approve an access request and add the member ────────────────────────
--   with req as (
--     update public.org_access_requests
--        set status = 'approved', reviewed_at = now(), reviewer_note = 'welcome'
--      where id = '<request-id>'
--    returning org_id, user_id)
--   insert into public.org_members (org_id, user_id, role_id, status, season_id)
--   select req.org_id, req.user_id,
--          (select id from public.org_roles r where r.org_id = req.org_id and r.key = 'member'),
--          'active',
--          (select id from public.org_seasons s where s.org_id = req.org_id and s.is_current
--            order by created_at desc limit 1)
--     from req
--   on conflict (org_id, user_id) do nothing;
--   -- (the UI in admin.html performs exactly this, in two requests)
--
-- ── Link a guardian to a student ────────────────────────────────────────
--   insert into public.org_guardians (org_id, guardian_member_id, member_id, relationship)
--   values ('<org>', '<parent member id>', '<student member id>', 'Mother')
--   on conflict do nothing;
--
-- ── Activate a plan after payment clears ────────────────────────────────
--   update public.organizations
--      set plan = 'ensemble', status = 'active',
--          renews_at = now() + interval '1 year',
--          storage_quota_bytes = 10737418240,   -- 10 GB (see core.js PLANS)
--          grace_ends_at = null
--    where slug = '<org-slug>';
--   -- pro: 26843545600 (25 GB) · program: 107374182400 (100 GB)
--
-- ── Issue an invoice against a request, then mark it paid ───────────────
--   update public.org_invoices
--      set status = 'sent', number = 'CAD-2026-0007', issued_at = now(),
--          amount_cents = 14900, due_on = current_date + 30
--    where id = '<invoice-id>';
--
--   update public.org_invoices set status = 'paid', paid_at = now()
--    where id = '<invoice-id>';
--   -- then flip the org to invoice_pending → active:
--   update public.organizations set status = 'active', renews_at = now() + interval '1 year'
--    where id = (select org_id from public.org_invoices where id = '<invoice-id>');
--
-- ── Nightly trial / grace sweep (cron; NEVER deletes anything) ──────────
--   update public.organizations
--      set status = 'read_only'
--    where (status = 'trialing'     and trial_ends_at < now())
--       or (status = 'grace_period' and grace_ends_at < now());
--   -- past_due → grace_period after a week of no payment:
--   update public.organizations
--      set status = 'grace_period', grace_ends_at = now() + interval '14 days'
--    where status = 'past_due' and updated_at < now() - interval '7 days';
--   -- an invoice that went unpaid past its due date:
--   update public.organizations o
--      set status = 'grace_period', grace_ends_at = now() + interval '14 days'
--     from public.org_invoices i
--    where i.org_id = o.id and i.status = 'sent' and i.due_on < current_date
--      and o.status = 'invoice_pending';
--
-- ── Close a form and export its submissions (managers only) ─────────────
--   update public.org_forms set is_open = false where id = '<form-id>';
--   select m.display_name, s.data
--     from public.org_form_submissions s
--     join public.org_members m on m.id = s.member_id
--    where s.form_id = '<form-id>' order by m.display_name;
-- ═══════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────
-- 0010_harden_grants.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — post-migration security hardening
--
-- From the Supabase advisor pass after 0009. Three findings, all real:
--   * 17 SECURITY DEFINER functions were executable by `anon`
--   * six of those are trigger-only and should be callable by nobody
--   * the workspace directory view was readable by signed-out visitors
--
-- Applied to the live project as migration `harden_function_grants`.
-- ═══════════════════════════════════════════════════════════════════════

-- 1. Trigger functions are trigger-only: nothing should reach them through
--    the REST API. Postgres fires triggers regardless of EXECUTE grants.
revoke execute on function public.bump_org_storage() from public, anon, authenticated;
revoke execute on function public.enforce_org_storage_quota() from public, anon, authenticated;
revoke execute on function public.seed_new_organization() from public, anon, authenticated;
revoke execute on function public.stamp_audit_actor() from public, anon, authenticated;
revoke execute on function public.stamp_form_submission() from public, anon, authenticated;
revoke execute on function public.sync_member_auto_groups() from public, anon, authenticated;

-- 2. Policy helpers are internals of RLS, not public RPCs. They must stay
--    executable by `authenticated` — a policy is evaluated with the caller's
--    privileges, so revoking that would make every policy raise — but signed
--    out visitors have no business calling them.
revoke execute on function public.can_manage_event(uuid) from public, anon;
revoke execute on function public.can_manage_packing_list(uuid) from public, anon;
revoke execute on function public.can_see_event(uuid) from public, anon;
revoke execute on function public.can_see_packing_list(uuid) from public, anon;
revoke execute on function public.can_see_signup(uuid) from public, anon;
revoke execute on function public.event_org(uuid) from public, anon;
revoke execute on function public.is_task_assignee(uuid) from public, anon;
revoke execute on function public.org_acts_for_member(uuid) from public, anon;
revoke execute on function public.poll_results_visible(uuid) from public, anon;
revoke execute on function public.signup_org(uuid) from public, anon;
revoke execute on function public.slot_signup(uuid) from public, anon;

grant execute on function public.can_manage_event(uuid) to authenticated;
grant execute on function public.can_manage_packing_list(uuid) to authenticated;
grant execute on function public.can_see_event(uuid) to authenticated;
grant execute on function public.can_see_packing_list(uuid) to authenticated;
grant execute on function public.can_see_signup(uuid) to authenticated;
grant execute on function public.event_org(uuid) to authenticated;
grant execute on function public.is_task_assignee(uuid) to authenticated;
grant execute on function public.org_acts_for_member(uuid) to authenticated;
grant execute on function public.poll_results_visible(uuid) to authenticated;
grant execute on function public.signup_org(uuid) to authenticated;
grant execute on function public.slot_signup(uuid) to authenticated;

-- 3. The workspace directory exists so someone can find an organization and
--    request access — which only makes sense signed in, and keeps the list of
--    organizations off the open internet.
revoke select on public.org_directory from anon;
grant select on public.org_directory to authenticated;

comment on view public.org_directory is
  'Safe, signed-in-only discovery surface for organizations: name, slug, type and whether they accept access requests. Deliberately a definer view so it can expose those columns without granting any access to public.organizations itself.';

comment on table public.plus_pending is
  'Service-role only by design: RLS is on with no policies, so no client can read or write it. Holds Cadence+ entitlements paid for before the buyer created an account.';


-- ───────────────────────────────────────────────
-- 0011_drill.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — drill design & dot books
--
-- The workspace learns to hold a show's drill: directors write charts in
-- the built-in designer, members open the same show and see their own dot
-- — where to stand for every set, how to get there, and at what stride.
--
-- Layout of the data:
--   drill_shows        one row per show/production, owned by an org
--   drill_performers   the dots: label ("T4"), section, look, and an
--                      optional link to the org member marching it
--   drill_sets         one row per page/set; positions live in a JSONB
--                      map {performer_id: [x, y]} in 8-to-5 steps, so a
--                      whole page saves as one UPDATE instead of hundreds
--                      of dot rows
--
-- Coordinates: x in steps from the 50 (Side 1 negative), y in steps from
-- the front sideline. Indoor floors use x from center, y from the front
-- edge. The client owns the interpretation; the database just stores steps.
--
-- Access: any active org member can read a show and every dot in it (a
-- dot book is useless if you can only see yourself). Writing takes the
-- new `drill.manage` permission — seeded to staff-level roles here, and
-- implied by org.admin as always. Members claim their own dot through a
-- guarded RPC rather than open UPDATE on the performers table.
--
-- Depends on: 0001 (touch_updated_at), 0005 (organizations, org_members,
-- is_org_member, org_can_write, org_member_id, seed_new_organization).
-- ═══════════════════════════════════════════════════════════════════════

-- ── shows ──────────────────────────────────────────────────────────────
create table public.drill_shows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  field_type text not null default 'hs'
    check (field_type in ('hs', 'college', 'pro', 'indoor')),
  tempo integer not null default 120 check (tempo between 40 and 300),
  notes text not null default '',
  archived boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index drill_shows_org on public.drill_shows (org_id, archived, updated_at desc);

-- ── performers (the dots) ──────────────────────────────────────────────
create table public.drill_performers (
  id uuid primary key default gen_random_uuid(),
  show_id uuid not null references public.drill_shows(id) on delete cascade,
  label text not null,                       -- the dot ID members search for
  name text not null default '',             -- optional real name / assignment
  section text not null default '',          -- Trumpets, Battery, Guard…
  symbol text not null default 'circle'
    check (symbol in ('circle', 'square', 'triangle', 'x', 'star')),
  color text not null default '#1971c2' check (color ~ '^#[0-9a-fA-F]{6}$'),
  member_id uuid references public.org_members(id) on delete set null,
  sort integer not null default 0,
  unique (show_id, label)
);
create index drill_performers_show on public.drill_performers (show_id, sort);
create index drill_performers_member on public.drill_performers (member_id);

-- ── sets (the pages) ───────────────────────────────────────────────────
create table public.drill_sets (
  id uuid primary key default gen_random_uuid(),
  show_id uuid not null references public.drill_shows(id) on delete cascade,
  idx integer not null,                      -- 0-based page order
  name text not null default '',
  counts integer not null default 16 check (counts between 0 and 512),  -- counts INTO this set
  hold integer not null default 0 check (hold between 0 and 512),
  tempo integer check (tempo between 40 and 300),  -- per-set override, null = show tempo
  notes text not null default '',
  dots jsonb not null default '{}'::jsonb,   -- {performer_id: [x, y]} in steps
  unique (show_id, idx) deferrable initially deferred  -- reordering swaps idx in one tx
);
create index drill_sets_show on public.drill_sets (show_id, idx);

create trigger drill_shows_touch before update on public.drill_shows
  for each row execute function public.touch_updated_at();

-- ── row security ───────────────────────────────────────────────────────
alter table public.drill_shows enable row level security;
alter table public.drill_performers enable row level security;
alter table public.drill_sets enable row level security;

create policy drill_shows_read on public.drill_shows
  for select using (public.is_org_member(org_id));
create policy drill_shows_write on public.drill_shows
  for all using (public.org_can_write(org_id, 'drill.manage'))
  with check (public.org_can_write(org_id, 'drill.manage'));

create policy drill_performers_read on public.drill_performers
  for select using (exists (
    select 1 from public.drill_shows s
    where s.id = show_id and public.is_org_member(s.org_id)));
create policy drill_performers_write on public.drill_performers
  for all using (exists (
    select 1 from public.drill_shows s
    where s.id = show_id and public.org_can_write(s.org_id, 'drill.manage')))
  with check (exists (
    select 1 from public.drill_shows s
    where s.id = show_id and public.org_can_write(s.org_id, 'drill.manage')));

create policy drill_sets_read on public.drill_sets
  for select using (exists (
    select 1 from public.drill_shows s
    where s.id = show_id and public.is_org_member(s.org_id)));
create policy drill_sets_write on public.drill_sets
  for all using (exists (
    select 1 from public.drill_shows s
    where s.id = show_id and public.org_can_write(s.org_id, 'drill.manage')))
  with check (exists (
    select 1 from public.drill_shows s
    where s.id = show_id and public.org_can_write(s.org_id, 'drill.manage')));

-- ── "this dot is me" ───────────────────────────────────────────────────
-- Members mark their own dot without write access to the performers table.
-- The function proves membership itself, so it is safe to expose as an RPC.
create or replace function public.claim_drill_dot(p_performer uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_me uuid;
begin
  select s.org_id into v_org
    from public.drill_performers p join public.drill_shows s on s.id = p.show_id
   where p.id = p_performer;
  if v_org is null then raise exception 'no such dot'; end if;
  v_me := public.org_member_id(v_org);
  if v_me is null then raise exception 'not a member of this workspace'; end if;
  -- one person, one dot per show: release anything they claimed before
  update public.drill_performers p set member_id = null
   where p.member_id = v_me
     and p.show_id = (select show_id from public.drill_performers where id = p_performer);
  update public.drill_performers set member_id = v_me where id = p_performer;
end $$;

create or replace function public.release_drill_dot(p_performer uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  select s.org_id into v_org
    from public.drill_performers p join public.drill_shows s on s.id = p.show_id
   where p.id = p_performer;
  if v_org is null then return; end if;
  -- you may release your own claim; drill writers may clear anyone's
  update public.drill_performers set member_id = null
   where id = p_performer
     and (member_id = public.org_member_id(v_org)
          or public.org_can_write(v_org, 'drill.manage'));
end $$;

revoke execute on function public.claim_drill_dot(uuid) from public, anon;
revoke execute on function public.release_drill_dot(uuid) from public, anon;
grant execute on function public.claim_drill_dot(uuid) to authenticated;
grant execute on function public.release_drill_dot(uuid) to authenticated;

-- ── permission seeding ─────────────────────────────────────────────────
-- Existing orgs: staff-level roles learn drill.manage. Owner and Director
-- carry org.admin, which already implies it.
update public.org_roles
   set permissions = permissions || '{drill.manage}'
 where key in ('assistant_director', 'staff', 'instructor')
   and not ('drill.manage' = any(permissions));

-- Future orgs: extend the 0005 seed without rewriting it. Triggers fire in
-- name order, so this runs right after organizations_seed on the same row.
create or replace function public.seed_org_drill_perms()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.org_roles
     set permissions = permissions || '{drill.manage}'
   where org_id = new.id
     and key in ('assistant_director', 'staff', 'instructor')
     and not ('drill.manage' = any(permissions));
  return new;
end $$;
revoke execute on function public.seed_org_drill_perms() from public, anon, authenticated;

create trigger organizations_seed_drill after insert on public.organizations
  for each row execute function public.seed_org_drill_perms();


-- ───────────────────────────────────────────────
-- 0012_security_hardening.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — workspace security hardening (stop-the-line fixes)
--
-- Seven vulnerabilities found in an adversarial audit of 0001-0011, each
-- fixed additively here with the attack it closes written out, because the
-- regression suite (scripts/test_db_security.py) replays these exact
-- attacks against a scratch database on every change:
--
--   0A  a member could PATCH their own org_members.role_id to Owner —
--       the members_self policy restricted rows, not columns
--   0B  org_members.role_id / org_invites.role_id could reference a role
--       from ANOTHER organization, importing its permissions cross-tenant
--   0C  storage accounting trusted the client's size_bytes, admins could
--       zero storage_used_bytes, and concurrent uploads raced the quota
--   0D  redeem_org_invite read uses/max_uses without locking — two
--       concurrent redemptions of the last use both succeeded
--   0E  claim_drill_dot overwrote another member's claimed dot silently
--   0F  youth-safety DM rules keyed on the client-supplied chat kind —
--       a two-person "group" chat bypassed pair_may_dm entirely
--   0G  usage_events.user_id was client-spoofable
--
-- Plus smaller items from the same audit: 0011's drill policies applied
-- to anon, and an approved Ensemble Pro claimant could be locked out of a
-- profile row created by someone else.
--
-- Append-only: nothing here rewrites an applied migration. Regenerate the
-- bundles with scripts/gen_sql_bundles.py after editing.
--
-- Depends on: 0005 (org core), 0006 (comms), 0008 (files), 0011 (drill).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 0B first: roles must belong to the org that uses them ─────────────
-- (before 0A so the role-change RPC below can rely on it)

-- composite key target for same-org foreign keys
alter table public.org_roles
  add constraint org_roles_org_id_id_key unique (org_id, id);

-- validate existing rows loudly rather than enforce onto bad data
do $$
declare bad int;
begin
  select count(*) into bad
    from public.org_members m join public.org_roles r on r.id = m.role_id
   where r.org_id <> m.org_id;
  if bad > 0 then
    raise exception 'org_members has % cross-org role assignment(s); fix before applying 0012', bad;
  end if;
  select count(*) into bad
    from public.org_invites i join public.org_roles r on r.id = i.role_id
   where r.org_id <> i.org_id;
  if bad > 0 then
    raise exception 'org_invites has % cross-org role reference(s); fix before applying 0012', bad;
  end if;
end $$;

alter table public.org_members
  add constraint org_members_role_same_org
  foreign key (org_id, role_id) references public.org_roles (org_id, id);

alter table public.org_invites
  add constraint org_invites_role_same_org
  foreign key (org_id, role_id) references public.org_roles (org_id, id);

-- ── 0A: membership rows can no longer change their own privileges ─────
-- The guard runs on EVERY update path. Direct PostgREST traffic runs as
-- `authenticated`; guarded RPCs below run as the function owner and the
-- billing system as service_role — both pass. Same pattern (SECURITY
-- INVOKER, current_user inspection) as guard_org_billing_fields in 0005.
create or replace function public.guard_member_update()
returns trigger language plpgsql set search_path = public as $$
declare claims_role text;
begin
  claims_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if claims_role = 'service_role' or current_user not in ('authenticated', 'anon') then
    return new;                        -- service role and definer RPCs
  end if;

  -- identity and tenancy never change through the API, for anyone
  if new.org_id is distinct from old.org_id
     or new.user_id is distinct from old.user_id then
    raise exception 'member_identity_readonly: org and user of a membership cannot change';
  end if;

  -- role changes only through set_member_role(), which audits and protects
  -- the last owner — a raw PATCH cannot do either
  if new.role_id is distinct from old.role_id then
    raise exception 'role_change_requires_rpc: change roles with set_member_role()';
  end if;

  -- everything else that carries privilege or capacity is staff-only
  if not public.org_has_perm(old.org_id, 'member.manage') then
    if new.status is distinct from old.status
       or new.season_id is distinct from old.season_id
       or new.section is distinct from old.section then
      raise exception 'member_fields_staff_only: only roster managers may change status, season or section';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.guard_member_update() from public, anon, authenticated;

drop trigger if exists org_members_guard on public.org_members;
create trigger org_members_guard before update on public.org_members
  for each row execute function public.guard_member_update();

-- the one sanctioned way to change a member's role
create or replace function public.set_member_role(p_member uuid, p_role uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.org_members%rowtype;
  admins int;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;

  select * into m from public.org_members where id = p_member for update;
  if not found then raise exception 'no_such_member'; end if;

  if not public.org_can_write(m.org_id, 'member.manage') then
    raise exception 'not_allowed: member.manage required';
  end if;

  -- nobody promotes (or demotes) themselves — a second admin must do it
  if m.user_id = auth.uid() then
    raise exception 'self_role_change_forbidden: another administrator must change your role';
  end if;

  -- the role must belong to this org (also enforced by the 0B constraint)
  if not exists (select 1 from public.org_roles r
                  where r.id = p_role and r.org_id = m.org_id) then
    raise exception 'role_not_in_org';
  end if;

  -- never leave the workspace without an active administrator
  if exists (select 1 from public.org_roles r
              where r.id = m.role_id and 'org.admin' = any (r.permissions))
     and not exists (select 1 from public.org_roles r
                      where r.id = p_role and 'org.admin' = any (r.permissions)) then
    select count(*) into admins
      from public.org_members mm
      join public.org_roles rr on rr.id = mm.role_id
     where mm.org_id = m.org_id and mm.status = 'active'
       and mm.id <> m.id and 'org.admin' = any (rr.permissions);
    if admins = 0 then
      raise exception 'last_admin: promote someone else before demoting the only administrator';
    end if;
  end if;

  update public.org_members set role_id = p_role where id = p_member;
  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (m.org_id, auth.uid(), 'member.role_changed', 'member', p_member::text);
end $$;
revoke execute on function public.set_member_role(uuid, uuid) from public, anon;
grant execute on function public.set_member_role(uuid, uuid) to authenticated;

-- ── 0C: storage accounting the client cannot lie to ───────────────────

-- usage joins the guarded billing fields (recreate = replace 0005's guard)
create or replace function public.guard_org_billing_fields()
returns trigger language plpgsql set search_path = public as $$
declare claims_role text;
begin
  claims_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if claims_role = 'service_role' or current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.plan is distinct from old.plan
     or new.status is distinct from old.status
     or new.trial_ends_at is distinct from old.trial_ends_at
     or new.grace_ends_at is distinct from old.grace_ends_at
     or new.renews_at is distinct from old.renews_at
     or new.storage_quota_bytes is distinct from old.storage_quota_bytes
     or new.storage_used_bytes is distinct from old.storage_used_bytes
     or new.stripe_customer_id is distinct from old.stripe_customer_id then
    raise exception
      'billing_fields_readonly: plan, status, dates and storage accounting are set by the system';
  end if;
  return new;
end $$;

-- quota check serialized: lock the org row so two concurrent uploads can't
-- both read the same "used" figure and both squeeze under the limit
create or replace function public.enforce_org_storage_quota()
returns trigger language plpgsql security definer set search_path = public as $$
declare o public.organizations%rowtype;
begin
  select * into o from public.organizations where id = new.org_id for update;
  if not found then raise exception 'unknown_org'; end if;
  if o.storage_used_bytes + coalesce(new.size_bytes, 0) > o.storage_quota_bytes then
    raise exception 'storage_quota_exceeded'
      using hint = 'This workspace is out of storage. Remove files or upgrade the plan.';
  end if;
  return new;
end $$;

-- size_bytes: a preflight estimate at insert, then reconciled from the
-- actual stored object. Clients cannot edit it afterwards.
create or replace function public.guard_file_size()
returns trigger language plpgsql set search_path = public as $$
declare claims_role text;
begin
  claims_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if claims_role = 'service_role' or current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.size_bytes is distinct from old.size_bytes then
    raise exception 'size_readonly: file size is reconciled from storage, not set by clients';
  end if;
  return new;
end $$;
revoke execute on function public.guard_file_size() from public, anon, authenticated;

drop trigger if exists org_files_guard_size on public.org_files;
create trigger org_files_guard_size before update on public.org_files
  for each row execute function public.guard_file_size();

-- reconcile a file row against the object that actually landed in the
-- bucket. Callable by any member who can see the file; reads only the
-- object's own metadata, so there is nothing to abuse.
create or replace function public.sync_file_size(p_file uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  f public.org_files%rowtype;
  actual bigint;
begin
  select * into f from public.org_files where id = p_file;
  if not found then raise exception 'no_such_file'; end if;
  if not public.is_org_member(f.org_id) then raise exception 'not_allowed'; end if;

  select nullif(o.metadata ->> 'size', '')::bigint into actual
    from storage.objects o
   where o.bucket_id = 'ensemble' and o.name = f.storage_path
   order by o.created_at desc limit 1;

  -- update the row only; the existing bump_org_storage trigger (0008) does
  -- the org-usage accounting on any size_bytes change, so touching it here
  -- too would double-count
  if actual is not null and actual is distinct from f.size_bytes then
    update public.org_files set size_bytes = actual where id = p_file;
  end if;
  return coalesce(actual, f.size_bytes);
end $$;
revoke execute on function public.sync_file_size(uuid) from public, anon;
grant execute on function public.sync_file_size(uuid) to authenticated;

-- ── 0D: invite redemption is atomic ───────────────────────────────────
create or replace function public.redeem_org_invite(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  inv public.org_invites%rowtype;
  member uuid;
  season uuid;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;

  -- lock the invite so the last use cannot be redeemed twice concurrently
  select * into inv from public.org_invites where code = p_code for update;
  if not found or (inv.expires_at is not null and inv.expires_at <= now()) then
    raise exception 'invite_invalid';
  end if;

  -- idempotent: an existing member re-entering the code just lands home,
  -- without consuming a use — checked BEFORE the exhausted-uses guard so a
  -- fully-used invite still lets its own members back in
  select id into member from public.org_members
   where org_id = inv.org_id and user_id = auth.uid();
  if member is not null then return inv.org_id; end if;

  if inv.uses >= inv.max_uses then raise exception 'invite_invalid'; end if;

  select id into season from public.org_seasons
   where org_id = inv.org_id and is_current order by created_at desc limit 1;

  insert into public.org_members (org_id, user_id, role_id, section, status, season_id)
  values (inv.org_id, auth.uid(),
          coalesce(inv.role_id, (select id from public.org_roles
                                  where org_id = inv.org_id and key = 'member')),
          inv.section, 'active', season)
  returning id into member;

  insert into public.org_group_members (group_id, member_id)
    select unnest(inv.group_ids), member on conflict do nothing;

  update public.org_invites set uses = uses + 1 where id = inv.id;
  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (inv.org_id, auth.uid(), 'member.joined_via_invite', 'member', member::text);
  return inv.org_id;
end $$;

-- ── 0E: a dot belongs to whoever claimed it ───────────────────────────
create or replace function public.claim_drill_dot(p_performer uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  perf public.drill_performers%rowtype;
  v_org uuid;
  v_me uuid;
begin
  select p.* into perf from public.drill_performers p where p.id = p_performer for update;
  if not found then raise exception 'no such dot'; end if;
  select s.org_id into v_org from public.drill_shows s where s.id = perf.show_id;
  v_me := public.org_member_id(v_org);
  if v_me is null then raise exception 'not a member of this workspace'; end if;

  -- taken by someone else? members cannot steal; drill managers use
  -- assign_drill_dot() to reassign on purpose
  if perf.member_id is not null and perf.member_id <> v_me then
    raise exception 'dot_taken'
      using hint = 'That dot is claimed by someone else. Ask your drill staff to reassign it.';
  end if;

  update public.drill_performers p set member_id = null
   where p.member_id = v_me and p.show_id = perf.show_id and p.id <> p_performer;
  update public.drill_performers set member_id = v_me where id = p_performer;
  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (v_org, auth.uid(), 'drill.dot_claimed', 'drill_performer', p_performer::text);
end $$;

-- staff reassignment, the deliberate path (p_member null = clear the dot)
create or replace function public.assign_drill_dot(p_performer uuid, p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  perf public.drill_performers%rowtype;
  v_org uuid;
begin
  select p.* into perf from public.drill_performers p where p.id = p_performer for update;
  if not found then raise exception 'no such dot'; end if;
  select s.org_id into v_org from public.drill_shows s where s.id = perf.show_id;
  if not public.org_can_write(v_org, 'drill.manage') then
    raise exception 'not_allowed: drill.manage required';
  end if;
  if p_member is not null and not exists (
      select 1 from public.org_members m where m.id = p_member and m.org_id = v_org) then
    raise exception 'member_not_in_org';
  end if;
  if p_member is not null then
    update public.drill_performers p set member_id = null
     where p.member_id = p_member and p.show_id = perf.show_id and p.id <> p_performer;
  end if;
  update public.drill_performers set member_id = p_member where id = p_performer;
  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (v_org, auth.uid(),
          case when p_member is null then 'drill.dot_cleared' else 'drill.dot_assigned' end,
          'drill_performer', p_performer::text);
end $$;
revoke execute on function public.assign_drill_dot(uuid, uuid) from public, anon;
grant execute on function public.assign_drill_dot(uuid, uuid) to authenticated;

-- ── 0F: youth safety follows the people in the room, not its label ────
-- Chats created by someone holding chat.create (staff-sanctioned,
-- moderated spaces) are exempt from pair rules; anything a plain member
-- creates is treated exactly like a DM no matter what kind it claims.
alter table public.chats
  add column if not exists safety_exempt boolean not null default false;

-- existing rooms: everything that isn't a DM predates member-created
-- abuse (member_created_chats orgs get the stricter rule from now on)
update public.chats set safety_exempt = true where kind <> 'dm';

create or replace function public.stamp_chat_safety()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.safety_exempt :=
    new.kind in ('org', 'staff')      -- structural rooms are staff spaces
    or public.org_has_perm(new.org_id, 'chat.create');
  return new;
end $$;
revoke execute on function public.stamp_chat_safety() from public, anon, authenticated;

drop trigger if exists chats_stamp_safety on public.chats;
create trigger chats_stamp_safety before insert on public.chats
  for each row execute function public.stamp_chat_safety();

-- pair rules now apply to every non-exempt chat, whatever its kind says
create or replace function public.dm_allowed(p_chat uuid, p_member uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when (select safety_exempt and kind is distinct from 'dm'
            from public.chats where id = p_chat)
      then true
    else not exists (
      select 1 from public.chat_members cm
       where cm.chat_id = p_chat and cm.member_id <> p_member
         and not public.pair_may_dm(cm.member_id, p_member))
  end
$$;

-- removing people cannot convert a sanctioned room into an unsafe pair:
-- when a non-exempt chat shrinks to two, the remaining pair must pass
create or replace function public.recheck_chat_pair()
returns trigger language plpgsql security definer set search_path = public as $$
declare a uuid; b uuid; exempt boolean; k text;
begin
  select safety_exempt, kind into exempt, k from public.chats where id = old.chat_id;
  if exempt and k is distinct from 'dm' then return old; end if;
  select min(member_id::text)::uuid, max(member_id::text)::uuid into a, b
    from public.chat_members where chat_id = old.chat_id;
  if a is not null and b is not null and a <> b
     and (select count(*) from public.chat_members where chat_id = old.chat_id) = 2
     and not public.pair_may_dm(a, b) then
    raise exception 'pair_not_allowed'
      using hint = 'Removing that member would leave a conversation these two may not have.';
  end if;
  return old;
end $$;
revoke execute on function public.recheck_chat_pair() from public, anon, authenticated;

drop trigger if exists chat_members_recheck_pair on public.chat_members;
create trigger chat_members_recheck_pair after delete on public.chat_members
  for each row execute function public.recheck_chat_pair();

-- ── 0G: analytics carry the real identity or none ─────────────────────
create or replace function public.stamp_usage_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();          -- null for anonymous, never spoofable
  if new.event is null or new.event not in ('view', 'action') then
    new.event := 'view';
  end if;
  -- session_id is a uuid column (fixed-size, safe); text fields are capped
  -- so a client cannot stuff private content or oversized payloads through
  new.app := left(coalesce(new.app, ''), 32);
  new.screen := left(coalesce(new.screen, ''), 64);
  new.detail := left(new.detail, 120);
  new.ref := left(new.ref, 120);
  return new;
end $$;
revoke execute on function public.stamp_usage_event() from public, anon, authenticated;

drop trigger if exists usage_events_stamp on public.usage_events;
create trigger usage_events_stamp before insert on public.usage_events
  for each row execute function public.stamp_usage_event();

-- ── 0011 cleanup: drill policies were the only ones without a role ────
alter policy drill_shows_read on public.drill_shows to authenticated;
alter policy drill_shows_write on public.drill_shows to authenticated;
alter policy drill_performers_read on public.drill_performers to authenticated;
alter policy drill_performers_write on public.drill_performers to authenticated;
alter policy drill_sets_read on public.drill_sets to authenticated;
alter policy drill_sets_write on public.drill_sets to authenticated;

-- ── approved claimants own their public profile, whoever created it ───
-- (fixes: a stale owner_user_id on ensemble_profiles blocked the flow
-- 0004 intended — approval is the authority, not the row's creator)
drop policy if exists ensemble_profiles_owner_update on public.ensemble_profiles;
create policy ensemble_profiles_owner_update on public.ensemble_profiles
  for update to authenticated
  using (public.has_approved_ensemble_claim(app_key, ensemble_name))
  with check (public.has_approved_ensemble_claim(app_key, ensemble_name));

create or replace function public.stamp_profile_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- the acting approved claimant becomes the owner of record
  if auth.uid() is not null then new.owner_user_id := auth.uid(); end if;
  return new;
end $$;
revoke execute on function public.stamp_profile_owner() from public, anon, authenticated;

drop trigger if exists ensemble_profiles_stamp_owner on public.ensemble_profiles;
create trigger ensemble_profiles_stamp_owner before update on public.ensemble_profiles
  for each row execute function public.stamp_profile_owner();

-- ── 0006 grant drift: fifteen policy helpers were revoked from public but
--    never re-granted to authenticated (0006:405-419), so every RLS policy
--    that calls them raised "permission denied for function" for real
--    signed-in users — chat creation, post visibility, DM safety and the
--    notification rule were all effectively broken. A policy is evaluated
--    with the caller's privileges, so these must be executable by
--    authenticated; they stay revoked from anon/public. (0010 did this for
--    0007's helpers; 0006's were missed.)
grant execute on function public.org_plan_has(uuid, text) to authenticated;
grant execute on function public.can_see_post(uuid) to authenticated;
grant execute on function public.can_edit_post(uuid) to authenticated;
grant execute on function public.post_member_id(uuid) to authenticated;
grant execute on function public.post_org(uuid) to authenticated;
grant execute on function public.chat_org(uuid) to authenticated;
grant execute on function public.chat_creator_or_mod(uuid) to authenticated;
grant execute on function public.chat_member_id(uuid) to authenticated;
grant execute on function public.is_chat_member(uuid) to authenticated;
grant execute on function public.member_is_staff(uuid) to authenticated;
grant execute on function public.pair_may_dm(uuid, uuid) to authenticated;
grant execute on function public.dm_allowed(uuid, uuid) to authenticated;
grant execute on function public.may_create_chat(uuid) to authenticated;
grant execute on function public.chat_is_open(uuid) to authenticated;
grant execute on function public.should_notify(uuid, text, uuid, text, text) to authenticated;


-- ───────────────────────────────────────────────
-- 0013_event_chats.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — event chat rooms
--
-- The event page has always linked to "Event chat", but the chats table had
-- an 'event' kind with no way to point at an event, so the link opened the
-- plain message list. This adds the missing link and one guarded RPC that
-- finds or creates the room for an event — atomically, so two people
-- tapping the button at once share one room instead of racing two.
--
-- Event chats are structural staff-adjacent spaces: they are moderated and
-- safety-exempt (0012's chat rule), scoped to members who can see the event.
--
-- Depends on: 0006 (chats), 0007 (org_events, can_see_event, event_org),
-- 0012 (chats.safety_exempt).
-- ═══════════════════════════════════════════════════════════════════════

alter table public.chats
  add column if not exists event_id uuid references public.org_events(id) on delete cascade;

-- one chat per event
create unique index if not exists chats_one_per_event
  on public.chats (event_id) where event_id is not null;

create index if not exists chats_event_idx on public.chats (event_id);

-- open (or create) the chat for an event. Returns the chat id.
create or replace function public.open_event_chat(p_event uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_me uuid;
  v_chat uuid;
  v_title text;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  v_org := public.event_org(p_event);
  if v_org is null then raise exception 'no_such_event'; end if;

  -- you must be able to see the event to be in its room
  if not public.can_see_event(p_event) then
    raise exception 'not_allowed: this event is not shared with you';
  end if;
  v_me := public.org_member_id(v_org);
  if v_me is null then raise exception 'not_a_member'; end if;

  -- find-or-create under the unique index; lock so concurrent taps agree
  select id into v_chat from public.chats where event_id = p_event for update;
  if v_chat is null then
    select 'Event · ' || coalesce(title, 'Untitled')
      into v_title from public.org_events where id = p_event;
    insert into public.chats (org_id, kind, event_id, title, created_by_member,
                              is_moderated, safety_exempt)
    values (v_org, 'event', p_event, v_title, v_me, true, true)
    returning id into v_chat;
  end if;

  -- ensure the caller is a participant (idempotent)
  insert into public.chat_members (chat_id, member_id)
  values (v_chat, v_me) on conflict do nothing;

  return v_chat;
end $$;
revoke execute on function public.open_event_chat(uuid) from public, anon;
grant execute on function public.open_event_chat(uuid) to authenticated;


-- ───────────────────────────────────────────────
-- 0014_notifications.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — workspace notification spine
--
-- A communications product has to actually deliver. This adds one
-- server-authoritative queue that every notification flows through, plus
-- the enqueue rules for the highest-value events. A trusted worker (running
-- with the service role, OUTSIDE the browser) drains the queue through
-- provider adapters; the client only ever reads its own rows.
--
-- What is enqueued here:
--   • an organization invitation (email)
--   • an announcement that requires acknowledgment (in-app + push), to each
--     member of its audience who has not silenced it (should_notify)
--   • an event that requests an RSVP (in-app + push), to its audience
--
-- Safety: the payload carries only what a template needs — titles, names,
-- links, counts. It never carries message bodies, medical/form answers,
-- drill coordinates, or contact details. Push copy stays generic where the
-- subject is sensitive; the worker owns that.
--
-- Depends on: 0005 (orgs/members/groups), 0006 (posts, post_targets,
-- should_notify), 0007 (org_events, targets), 0012 (guards).
-- ═══════════════════════════════════════════════════════════════════════

create table public.org_notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  recipient_member_id uuid references public.org_members(id) on delete cascade,
  recipient_email text,                       -- for invites (no member yet)
  type text not null,                          -- 'invite' | 'ack_post' | 'rsvp' | …
  channel text not null check (channel in ('inapp', 'push', 'email')),
  priority text not null default 'normal'
    check (priority in ('normal', 'important', 'urgent')),
  -- template-safe data ONLY: never message bodies, medical answers, contacts
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null,                    -- collapses duplicates
  scheduled_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped', 'canceled')),
  attempts int not null default 0,
  last_error text,
  read_at timestamptz,                         -- for the in-app channel
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
-- idempotency: one row per (recipient, dedupe_key, channel)
create unique index org_notifications_dedupe
  on public.org_notifications (dedupe_key, channel, coalesce(recipient_member_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(recipient_email, ''));
create index org_notifications_worker
  on public.org_notifications (status, scheduled_at) where status = 'pending';
create index org_notifications_recipient
  on public.org_notifications (recipient_member_id, channel, read_at);

-- ── enqueue (definer; called by triggers and by the worker's helpers) ──
create or replace function public.enqueue_notification(
  p_org uuid, p_member uuid, p_email text, p_type text, p_channel text,
  p_priority text, p_payload jsonb, p_dedupe text, p_when timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.org_notifications
    (org_id, recipient_member_id, recipient_email, type, channel, priority,
     payload, dedupe_key, scheduled_at)
  values
    (p_org, p_member, p_email, p_type, p_channel, coalesce(p_priority, 'normal'),
     coalesce(p_payload, '{}'::jsonb), p_dedupe, coalesce(p_when, now()))
  on conflict do nothing;   -- dedupe index makes re-enqueue harmless
end $$;
revoke execute on function public.enqueue_notification(uuid, uuid, text, text, text, text, jsonb, text, timestamptz)
  from public, anon, authenticated;

-- resolve a post's audience to concrete member ids (no targets = whole org)
create or replace function public.post_audience(p_post uuid)
returns table (member_id uuid) language sql stable security definer set search_path = public as $$
  with p as (select org_id from public.posts where id = p_post),
       t as (select * from public.post_targets where post_id = p_post)
  select m.id from public.org_members m, p
   where m.org_id = p.org_id and m.status = 'active'
     and (
       not exists (select 1 from t)                                   -- whole org
       or exists (select 1 from t where t.member_id = m.id)           -- direct
       or exists (select 1 from t
                   join public.org_group_members gm on gm.group_id = t.group_id
                  where gm.member_id = m.id)                          -- by group
       or exists (select 1 from t
                   join public.org_roles r on r.id = m.role_id
                  where t.role_kind = r.kind)                         -- by role kind
     )
$$;
revoke execute on function public.post_audience(uuid) from public, anon, authenticated;

-- ── trigger: an acknowledgment-required announcement ───────────────────
create or replace function public.notify_ack_post()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m uuid;
  pay jsonb;
begin
  -- only when it actually requires an ack and is (or just became) published
  if new.requires_ack is not true or new.archived is true then return new; end if;
  if new.publish_at is not null and new.publish_at > now() then return new; end if;
  -- on UPDATE, only fire when it newly requires ack / newly publishes
  if tg_op = 'UPDATE' and old.requires_ack is true
     and (old.publish_at is null or old.publish_at <= now())
     and old.archived is false then
    return new;
  end if;

  pay := jsonb_build_object('post_id', new.id, 'title', left(coalesce(new.title, 'Announcement'), 140));
  for m in select member_id from public.post_audience(new.id) loop
    if m = new.author_member_id then continue; end if;   -- not your own post
    if public.should_notify(m, 'announcement', new.id, 'inapp', new.priority) then
      perform public.enqueue_notification(new.org_id, m, null, 'ack_post', 'inapp',
        new.priority, pay, 'ack:' || new.id || ':' || m, now());
    end if;
    if public.should_notify(m, 'announcement', new.id, 'push', new.priority) then
      perform public.enqueue_notification(new.org_id, m, null, 'ack_post', 'push',
        new.priority, pay, 'ack:' || new.id || ':' || m, now());
    end if;
  end loop;
  return new;
end $$;
revoke execute on function public.notify_ack_post() from public, anon, authenticated;

drop trigger if exists posts_notify_ack on public.posts;
create trigger posts_notify_ack after insert or update on public.posts
  for each row execute function public.notify_ack_post();

-- ── trigger: an organization invitation with an email ──────────────────
create or replace function public.notify_invite()
returns trigger language plpgsql security definer set search_path = public as $$
declare org_name text;
begin
  if new.email is null or btrim(new.email) = '' then return new; end if;
  select name into org_name from public.organizations where id = new.org_id;
  perform public.enqueue_notification(
    new.org_id, null, new.email, 'invite', 'email', 'important',
    jsonb_build_object('org_name', org_name, 'code', new.code,
      -- the join link is safe to template; the raw code rides only so the
      -- worker can build the link, and is never logged as an error detail
      'expires_at', new.expires_at),
    'invite:' || new.id, now());
  return new;
end $$;
revoke execute on function public.notify_invite() from public, anon, authenticated;

drop trigger if exists org_invites_notify on public.org_invites;
create trigger org_invites_notify after insert on public.org_invites
  for each row execute function public.notify_invite();

-- ── trigger: an event that requests an RSVP ────────────────────────────
-- Event targeting is group-based (org_event_targets.group_id); no targets
-- means the whole org.
create or replace function public.notify_rsvp_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare m uuid; pay jsonb;
begin
  if new.rsvp_required is not true then return new; end if;
  if tg_op = 'UPDATE' and old.rsvp_required is true then return new; end if;
  pay := jsonb_build_object('event_id', new.id, 'title', left(coalesce(new.title, 'Event'), 140),
                            'starts_at', new.starts_at);
  for m in
    select mm.id from public.org_members mm
     where mm.org_id = new.org_id and mm.status = 'active'
       and (
         not exists (select 1 from public.org_event_targets et where et.event_id = new.id)
         or exists (select 1 from public.org_event_targets et
                     join public.org_group_members gm on gm.group_id = et.group_id
                    where et.event_id = new.id and gm.member_id = mm.id))
  loop
    if public.should_notify(m, 'event', new.id, 'inapp', 'normal') then
      perform public.enqueue_notification(new.org_id, m, null, 'rsvp', 'inapp',
        'normal', pay, 'rsvp:' || new.id || ':' || m, now());
    end if;
  end loop;
  return new;
end $$;
revoke execute on function public.notify_rsvp_event() from public, anon, authenticated;

drop trigger if exists org_events_notify_rsvp on public.org_events;
create trigger org_events_notify_rsvp after insert or update on public.org_events
  for each row execute function public.notify_rsvp_event();

-- ── worker surface (service role only) ─────────────────────────────────
-- The worker claims a batch of due pending rows, sends them through its
-- provider adapters, then marks each. mark_notification is the only way the
-- status advances; nothing the client can call touches it.
create or replace function public.claim_notifications(p_limit int default 50)
returns setof public.org_notifications language plpgsql security definer set search_path = public as $$
begin
  return query
    update public.org_notifications n set attempts = attempts + 1
     where n.id in (
       select id from public.org_notifications
        where status = 'pending' and scheduled_at <= now()
        order by scheduled_at
        for update skip locked
        limit greatest(1, least(p_limit, 200)))
    returning n.*;
end $$;
revoke execute on function public.claim_notifications(int) from public, anon, authenticated;

create or replace function public.mark_notification(p_id uuid, p_status text, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.org_notifications
     set status = p_status,
         last_error = left(p_error, 300),
         sent_at = case when p_status = 'sent' then now() else sent_at end
   where id = p_id;
end $$;
revoke execute on function public.mark_notification(uuid, text, text) from public, anon, authenticated;

-- ── RLS: a member sees their own in-app notifications, nothing else ────
alter table public.org_notifications enable row level security;

create policy notif_read_own on public.org_notifications for select to authenticated
  using (channel = 'inapp' and recipient_member_id = public.org_member_id(org_id));

-- a member may only mark their own in-app row read (read_at); the guard
-- below stops them from touching status/priority/anything else
create policy notif_mark_read on public.org_notifications for update to authenticated
  using (channel = 'inapp' and recipient_member_id = public.org_member_id(org_id))
  with check (channel = 'inapp' and recipient_member_id = public.org_member_id(org_id));

create or replace function public.guard_notification_update()
returns trigger language plpgsql set search_path = public as $$
declare claims_role text;
begin
  claims_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if claims_role = 'service_role' or current_user not in ('authenticated', 'anon') then
    return new;                         -- the worker (service role) may do anything
  end if;
  -- a signed-in recipient may change ONLY read_at
  if new.status is distinct from old.status
     or new.payload is distinct from old.payload
     or new.priority is distinct from old.priority
     or new.channel is distinct from old.channel
     or new.recipient_member_id is distinct from old.recipient_member_id
     or new.attempts is distinct from old.attempts then
    raise exception 'notification_readonly: only read_at may be set by a recipient';
  end if;
  return new;
end $$;
revoke execute on function public.guard_notification_update() from public, anon, authenticated;

drop trigger if exists org_notifications_guard on public.org_notifications;
create trigger org_notifications_guard before update on public.org_notifications
  for each row execute function public.guard_notification_update();

-- no client insert/delete policy exists, so only the service role (which
-- bypasses RLS) and the definer enqueue function can create rows


-- ───────────────────────────────────────────────
-- 0015_platform_admin.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — platform administration
--
-- Until now, running the platform meant hand-editing rows in the SQL
-- editor (approving claims, activating plans, marking invoices paid —
-- the runbooks in 0004/0005/0009's comments). This gives the owner a real
-- surface: narrow SECURITY DEFINER RPCs, every one gated on
-- profiles.role = 'platform_admin' (0004 defines the role and already
-- blocks self-assignment), every action audited. docs/admin-platform.html
-- is the UI; the SQL runbooks remain as emergency fallbacks.
--
-- The service-role key is NOT used by any of this — the owner signs in
-- like any user, and the platform_admin row (set once, by the owner, in
-- the dashboard) is the authority. Enable MFA on that account before
-- production use; the RPCs are written so an MFA (aal2) requirement can
-- be added as one line when Supabase MFA is turned on.
--
-- Depends on: 0001 (claims), 0004 (profiles.role), 0005 (organizations),
-- 0009 (org_invoices), 0014 (org_notifications).
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                  where id = auth.uid() and role = 'platform_admin')
$$;
revoke execute on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

-- immutable platform-level audit (separate from per-org logs on purpose:
-- org admins must not see platform operations)
create table public.platform_audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
alter table public.platform_audit_log enable row level security;
create policy padmin_audit_read on public.platform_audit_log
  for select to authenticated using (public.is_platform_admin());
-- no insert/update/delete policies: only the definer functions write

create or replace function public.padmin_log(p_action text, p_type text, p_id text, p_detail jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.platform_audit_log (actor_user_id, action, target_type, target_id, detail)
  values (auth.uid(), p_action, p_type, p_id, coalesce(p_detail, '{}'::jsonb));
end $$;
revoke execute on function public.padmin_log(text, text, text, jsonb) from public, anon, authenticated;

-- every RPC starts here
create or replace function public.padmin_require()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'platform_admin_required';
  end if;
end $$;
revoke execute on function public.padmin_require() from public, anon, authenticated;

-- ── claims review ──────────────────────────────────────────────────────
create or replace function public.padmin_list_claims(p_status text default 'pending')
returns table (id uuid, user_id uuid, kind text, app_key text, target_name text,
               claimant_role text, message text, status text, created_at timestamptz,
               claimant_email text)
language sql stable security definer set search_path = public as $$
  select c.id, c.user_id, c.kind, c.app_key, c.target_name, c.claimant_role,
         c.message, c.status, c.created_at, u.email
    from public.claims c left join auth.users u on u.id = c.user_id
   where public.is_platform_admin()
     and (p_status is null or c.status = p_status)
   order by c.created_at
$$;
revoke execute on function public.padmin_list_claims(text) from public, anon;
grant execute on function public.padmin_list_claims(text) to authenticated;

create or replace function public.padmin_review_claim(p_claim uuid, p_action text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c public.claims%rowtype;
begin
  perform public.padmin_require();
  if p_action not in ('approved', 'rejected', 'pending') then
    raise exception 'bad_action: approved / rejected / pending';
  end if;
  select * into c from public.claims where id = p_claim for update;
  if not found then raise exception 'no_such_claim'; end if;
  update public.claims
     set status = p_action, reviewed_at = now(), reviewer_note = p_note
   where id = p_claim;
  perform public.padmin_log('claim.' || p_action, 'claim', p_claim::text,
    jsonb_build_object('app_key', c.app_key, 'target', c.target_name));
end $$;
revoke execute on function public.padmin_review_claim(uuid, text, text) from public, anon;
grant execute on function public.padmin_review_claim(uuid, text, text) to authenticated;

-- ── organizations & plans ──────────────────────────────────────────────
create or replace function public.padmin_list_orgs()
returns table (id uuid, name text, slug text, plan text, status text,
               trial_ends_at timestamptz, renews_at timestamptz,
               storage_used_bytes bigint, storage_quota_bytes bigint,
               members bigint, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.slug, o.plan, o.status, o.trial_ends_at, o.renews_at,
         o.storage_used_bytes, o.storage_quota_bytes,
         (select count(*) from public.org_members m
           where m.org_id = o.id and m.status = 'active'),
         o.created_at
    from public.organizations o
   where public.is_platform_admin()
   order by o.created_at desc
$$;
revoke execute on function public.padmin_list_orgs() from public, anon;
grant execute on function public.padmin_list_orgs() to authenticated;

-- activate / change a plan (the invoice-paid path; Stripe's webhook uses
-- the service role instead and never calls this)
create or replace function public.padmin_set_plan(
  p_org uuid, p_plan text, p_renews_at timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
declare quota bigint;
begin
  perform public.padmin_require();
  if p_plan not in ('ensemble', 'pro', 'program') then
    raise exception 'bad_plan: ensemble / pro / program';
  end if;
  quota := case p_plan when 'ensemble' then 10737418240      -- 10 GB
                       when 'pro' then 26843545600            -- 25 GB
                       else 107374182400 end;                 -- 100 GB
  update public.organizations
     set plan = p_plan, status = 'active',
         renews_at = coalesce(p_renews_at, now() + interval '1 year'),
         grace_ends_at = null,
         storage_quota_bytes = greatest(storage_quota_bytes, quota)
   where id = p_org;
  if not found then raise exception 'no_such_org'; end if;
  perform public.padmin_log('org.plan_set', 'org', p_org::text,
    jsonb_build_object('plan', p_plan));
end $$;
revoke execute on function public.padmin_set_plan(uuid, text, timestamptz) from public, anon;
grant execute on function public.padmin_set_plan(uuid, text, timestamptz) to authenticated;

create or replace function public.padmin_extend_trial(p_org uuid, p_days int)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.padmin_require();
  if p_days is null or p_days < 1 or p_days > 180 then
    raise exception 'bad_days: 1-180';
  end if;
  update public.organizations
     set status = 'trialing',
         trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => p_days)
   where id = p_org;
  if not found then raise exception 'no_such_org'; end if;
  perform public.padmin_log('org.trial_extended', 'org', p_org::text,
    jsonb_build_object('days', p_days));
end $$;
revoke execute on function public.padmin_extend_trial(uuid, int) from public, anon;
grant execute on function public.padmin_extend_trial(uuid, int) to authenticated;

-- ── invoices ───────────────────────────────────────────────────────────
create or replace function public.padmin_list_invoices(p_status text default null)
returns table (id uuid, org_id uuid, org_name text, number text, amount_cents bigint,
               status text, plan text, due_on date, issued_at timestamptz,
               paid_at timestamptz, note text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.id, i.org_id, o.name, i.number, i.amount_cents, i.status, i.plan,
         i.due_on, i.issued_at, i.paid_at, i.note, i.created_at
    from public.org_invoices i join public.organizations o on o.id = i.org_id
   where public.is_platform_admin()
     and (p_status is null or i.status = p_status)
   order by i.created_at desc
$$;
revoke execute on function public.padmin_list_invoices(text) from public, anon;
grant execute on function public.padmin_list_invoices(text) to authenticated;

create or replace function public.padmin_issue_invoice(
  p_invoice uuid, p_number text, p_amount_cents bigint, p_due date)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.padmin_require();
  update public.org_invoices
     set number = p_number, amount_cents = p_amount_cents,
         due_on = p_due, status = 'sent', issued_at = now()
   where id = p_invoice and status in ('requested', 'sent');
  if not found then raise exception 'no_such_invoice_or_not_issuable'; end if;
  perform public.padmin_log('invoice.issued', 'invoice', p_invoice::text,
    jsonb_build_object('number', p_number, 'amount_cents', p_amount_cents));
end $$;
revoke execute on function public.padmin_issue_invoice(uuid, text, bigint, date) from public, anon;
grant execute on function public.padmin_issue_invoice(uuid, text, bigint, date) to authenticated;

-- marking paid activates the plan in the same transaction — the two never
-- drift apart the way the manual runbook could
create or replace function public.padmin_mark_invoice_paid(p_invoice uuid)
returns void language plpgsql security definer set search_path = public as $$
declare inv public.org_invoices%rowtype;
begin
  perform public.padmin_require();
  select * into inv from public.org_invoices where id = p_invoice for update;
  if not found then raise exception 'no_such_invoice'; end if;
  if inv.status = 'paid' then return; end if;    -- idempotent
  if inv.status not in ('sent', 'requested') then
    raise exception 'invoice_not_payable';
  end if;
  update public.org_invoices set status = 'paid', paid_at = now() where id = p_invoice;
  if inv.plan in ('ensemble', 'pro', 'program') then
    perform public.padmin_set_plan(inv.org_id, inv.plan,
      coalesce(inv.period_end::timestamptz, now() + interval '1 year'));
  end if;
  perform public.padmin_log('invoice.paid', 'invoice', p_invoice::text,
    jsonb_build_object('org', inv.org_id, 'plan', inv.plan));
end $$;
revoke execute on function public.padmin_mark_invoice_paid(uuid) from public, anon;
grant execute on function public.padmin_mark_invoice_paid(uuid) to authenticated;

-- ── operational health, one call ───────────────────────────────────────
create or replace function public.padmin_health()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public.is_platform_admin() then jsonb_build_object(
    'pending_claims', (select count(*) from public.claims where status = 'pending'),
    'orgs', (select count(*) from public.organizations),
    'trials_expiring_14d', (select count(*) from public.organizations
       where status = 'trialing' and trial_ends_at < now() + interval '14 days'),
    'read_only_orgs', (select count(*) from public.organizations
       where status in ('read_only', 'expired')),
    'invoices_awaiting', (select count(*) from public.org_invoices
       where status in ('requested', 'sent')),
    'notifications_failed', (select count(*) from public.org_notifications
       where status = 'failed'),
    'notifications_pending', (select count(*) from public.org_notifications
       where status = 'pending')
  ) else null end
$$;
revoke execute on function public.padmin_health() from public, anon;
grant execute on function public.padmin_health() to authenticated;

-- ── the trial/grace sweep the runbook used to do by hand ───────────────
-- Idempotent; run from the worker on a timer or by the admin page button.
create or replace function public.padmin_sweep_subscriptions()
returns jsonb language plpgsql security definer set search_path = public as $$
declare expired int; graced int;
begin
  perform public.padmin_require();
  update public.organizations set status = 'read_only'
   where status = 'trialing' and trial_ends_at is not null and trial_ends_at < now();
  get diagnostics expired = row_count;
  update public.organizations set status = 'read_only'
   where status = 'grace_period' and grace_ends_at is not null and grace_ends_at < now();
  get diagnostics graced = row_count;
  perform public.padmin_log('subscriptions.swept', null, null,
    jsonb_build_object('trials_expired', expired, 'grace_expired', graced));
  return jsonb_build_object('trials_expired', expired, 'grace_expired', graced);
end $$;
revoke execute on function public.padmin_sweep_subscriptions() from public, anon;
grant execute on function public.padmin_sweep_subscriptions() to authenticated;


-- ───────────────────────────────────────────────
-- 0016_stripe_events.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — Stripe webhook idempotency ledger
--
-- Every Stripe event the webhook processes is recorded here FIRST; the
-- primary key makes a second delivery of the same event a no-op (Stripe
-- retries on any non-2xx, and deliveries can arrive out of order — the
-- handlers set absolute state, so replay-safety only needs this dedupe).
--
-- Service-role only: RLS is enabled with no policies, so no client can
-- read or write it. The webhook edge function bypasses RLS by design.
--
-- Depends on: nothing new (organizations.stripe_customer_id is 0005).
-- ═══════════════════════════════════════════════════════════════════════

create table public.stripe_events (
  id text primary key,                -- Stripe event id ('evt_…')
  type text not null,
  received_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;
-- no policies on purpose: the service role bypasses RLS, everyone else
-- (anon, authenticated) has no path in

-- keep the ledger from growing forever: the platform admin sweep may prune
-- entries older than 90 days (Stripe never retries that far back)
create or replace function public.prune_stripe_events()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public.padmin_require();
  delete from public.stripe_events where received_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.prune_stripe_events() from public, anon;
grant execute on function public.prune_stripe_events() to authenticated;


-- ───────────────────────────────────────────────
-- 0017_storage_policies.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — the `ensemble` bucket's four object policies, standalone
--
-- 0008 creates these inside an exception-guarded DO block, because on some
-- projects the SQL editor's role cannot alter storage.objects and an abort
-- there would have rolled back all 56 tables. On this project that block
-- WAS skipped, which left the private bucket with zero policies — RLS on,
-- nothing allowed, so every upload and download was denied.
--
-- This file applies them on their own, so the state is reproducible instead
-- of depending on which role happened to run 0008. It is safe to re-run and
-- safe to run before or after 0008 (the helper functions it calls are
-- created there; run 0008 first on a fresh project).
--
-- If this file fails with "must be owner of table objects", your SQL role
-- lacks the privilege — apply it through the Supabase MCP/management API,
-- or create the same four policies in Dashboard → Storage → Policies.
--
-- Depends on: 0008 (bucket + can_*_ensemble_object helpers).
-- ═══════════════════════════════════════════════════════════════════════

-- Exception-guarded like 0008's block, because this file also rides inside
-- the single-transaction RUN_ALL / RUN_ENSEMBLE bundles: an unguarded
-- failure here would roll the whole bundle back. Guarded, it applies where
-- the role is privileged (MCP / management API) and prints a notice where
-- it is not — never taking the rest of the schema down with it.
do $$
begin
  execute 'alter table storage.objects enable row level security';

  execute 'drop policy if exists ensemble_objects_read on storage.objects';
  execute $p$create policy ensemble_objects_read on storage.objects for select to authenticated
    using (bucket_id = 'ensemble' and public.can_read_ensemble_object(name))$p$;

  execute 'drop policy if exists ensemble_objects_insert on storage.objects';
  execute $p$create policy ensemble_objects_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'ensemble' and public.can_write_ensemble_object(name))$p$;

  execute 'drop policy if exists ensemble_objects_update on storage.objects';
  execute $p$create policy ensemble_objects_update on storage.objects for update to authenticated
    using (bucket_id = 'ensemble' and public.can_write_ensemble_object(name))
    with check (bucket_id = 'ensemble' and public.can_write_ensemble_object(name))$p$;

  execute 'drop policy if exists ensemble_objects_delete on storage.objects';
  execute $p$create policy ensemble_objects_delete on storage.objects for delete to authenticated
    using (bucket_id = 'ensemble' and public.can_delete_ensemble_object(name))$p$;

  raise notice 'Cadence: ensemble storage policies applied.';
exception
  when insufficient_privilege or undefined_table then
    raise notice 'Cadence: this role cannot alter storage.objects (%). Apply 0017 through the Supabase MCP/management API, or create the four policies in Dashboard -> Storage -> Policies. Until then file upload/download stays denied.', sqlerrm;
end $$;


-- ───────────────────────────────────────────────
-- 0018_auto_sweep.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — unattended subscription sweep (+ the past_due gap it closes)
--
-- Two problems with 0015's sweep:
--
--   1. It is gated on `padmin_require()`, which needs `auth.uid()`. A timer
--      (pg_cron, a worker, anything without a signed-in user) therefore
--      cannot run it — so trial and grace expiry only ever happened when a
--      human opened admin-platform.html and pressed the button.
--
--   2. It only expired `grace_period`. But the Stripe webhook records a
--      failed payment as `status = 'past_due'` with a `grace_ends_at` 14
--      days out (see supabase/functions/_shared/stripe-core.js,
--      `invoice.payment_failed`), and `org_writable()` counts `past_due`
--      as writable. Nothing ever moved those organizations on. A workspace
--      whose card failed stayed fully writable forever.
--
-- This file adds `sweep_subscriptions_auto()` — the same state machine with
-- no signed-in-user requirement, executable only by the owner (postgres)
-- and the service role, never by `anon` or `authenticated` — makes the
-- admin RPC a thin authorised wrapper around it, and schedules it hourly
-- with pg_cron where the extension is available.
--
-- Nothing is ever deleted: `read_only` keeps every announcement, file,
-- message and attendance record readable. Only new writing stops.
--
-- Depends on: 0005 (organizations), 0015 (padmin_log, padmin_require).
-- ═══════════════════════════════════════════════════════════════════════

-- ── the unattended sweep ───────────────────────────────────────────────
-- SECURITY DEFINER with no caller check on purpose: the privilege boundary
-- is the EXECUTE grant below, not a claim inspected at runtime. Browsers
-- (anon / authenticated) cannot reach it at all; the admin RPC and the
-- scheduler can.
create or replace function public.sweep_subscriptions_auto()
returns jsonb language plpgsql security definer set search_path = public as $$
declare expired int; graced int; overdue int;
begin
  update public.organizations set status = 'read_only'
   where status = 'trialing' and trial_ends_at is not null and trial_ends_at < now();
  get diagnostics expired = row_count;

  update public.organizations set status = 'read_only'
   where status = 'grace_period' and grace_ends_at is not null and grace_ends_at < now();
  get diagnostics graced = row_count;

  -- the gap: a failed card leaves the org `past_due` with a grace deadline
  update public.organizations set status = 'read_only'
   where status = 'past_due' and grace_ends_at is not null and grace_ends_at < now();
  get diagnostics overdue = row_count;

  perform public.padmin_log('subscriptions.swept', null, null,
    jsonb_build_object('trials_expired', expired, 'grace_expired', graced,
                       'past_due_expired', overdue));

  return jsonb_build_object('trials_expired', expired, 'grace_expired', graced,
                            'past_due_expired', overdue);
end $$;

revoke all on function public.sweep_subscriptions_auto() from public, anon, authenticated;
-- the service role is server-side only (worker / edge function), so it may
-- drive the sweep on a timer without a signed-in platform admin
grant execute on function public.sweep_subscriptions_auto() to service_role;

-- ── the admin button now delegates ─────────────────────────────────────
-- One implementation, two doors. `padmin_require()` still guards the door
-- a browser can knock on; inside the definer body the effective user is the
-- owner, so the revoked helper is reachable from here and nowhere else.
create or replace function public.padmin_sweep_subscriptions()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.padmin_require();
  return public.sweep_subscriptions_auto();
end $$;
revoke execute on function public.padmin_sweep_subscriptions() from public, anon;
grant execute on function public.padmin_sweep_subscriptions() to authenticated;

-- ── schedule it, where the platform allows ─────────────────────────────
-- Guarded exactly like 0017's storage block: this file also rides inside
-- the single-transaction RUN_ALL / RUN_ENSEMBLE bundles, and pg_cron is a
-- hosted-platform privilege that a scratch database or a restricted SQL
-- role will not have. Where it fails, the admin page button still works and
-- this prints a notice instead of taking the whole schema down with it.
--
-- :17 past the hour rather than :00 so it never lands in the same minute as
-- the platform's own maintenance jobs.
do $$
begin
  execute 'create extension if not exists pg_cron';
  perform cron.schedule('cadence-subscription-sweep', '17 * * * *',
                        'select public.sweep_subscriptions_auto()');
  raise notice 'Cadence: hourly subscription sweep scheduled (pg_cron).';
exception
  when others then
    raise notice 'Cadence: could not schedule the sweep with pg_cron (%). Trial and grace expiry then depend on the admin-platform.html button, or on any scheduler that can call sweep_subscriptions_auto() with the service role.', sqlerrm;
end $$;


-- ───────────────────────────────────────────────
-- 0019_notification_release.sql
-- ───────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — notifications that reach the right people, at the right time
--
-- 0014 enqueued from AFTER INSERT row triggers. Three consequences, all
-- real, all closed here.
--
--   1. CONFIDENTIALITY. docs/ensemble/feed.html writes the post, then the
--      post_targets rows in a SECOND request. post_audience() (0014:72-88)
--      resolves "no target rows" as the whole organization, and at INSERT
--      time there are none — so an announcement aimed at one section
--      enqueued a notification carrying left(title, 140) to every active
--      member of the org, whose RLS then denied them the post itself. The
--      title of a restricted announcement is not noise, it is a leak.
--      org_events + org_event_targets had the same shape.
--
--   2. PREFERENCES. should_notify() was called with scope 'announcement' /
--      'event', scope_id = the post/event id, and channel 'inapp'. But
--      org_notification_prefs constrains scope to ('org', 'group', 'chat')
--      and channel to ('push', 'email') (0006:209,211), and scope_id means
--      the org/group/chat — so the lookup could never match a row. The
--      coalesce fell through to 'all' and every member preference was
--      ignored, level 'none' included, exactly opposite to what 0014's own
--      header promises.
--
--   3. SCHEDULING. posts.publish_at is "future = scheduled" (0006:69). The
--      trigger returned early for a future-dated post, and no later event
--      ever re-fired it, so a scheduled must-read announcement notified
--      nobody, ever.
--
-- The shape of the fix: enqueueing is no longer a side effect of INSERT.
--
--   • public.publish_post(post) is an explicit, permission-checked step the
--     client calls AFTER the targets are written. Nothing is enqueued until
--     it does, so a client that dies between the two calls leaves an
--     announcement that never notifies — the safe failure — and never a
--     title fanned out to the whole organization.
--   • A post scheduled for later registers a release for its publish_at
--     instead of enqueueing now. release_due_notifications() drains what is
--     due, resolving the audience at that moment; claim_notifications()
--     runs it before every worker batch, and pg_cron runs it each minute
--     where the platform allows.
--   • Events keep their trigger, but DEFERRED: org_event_create() (0007)
--     writes the event and its targets in one transaction, so at COMMIT the
--     audience is finally correct. An edit that turns RSVP on rewrites its
--     targets in a separate request, so that path registers a short-delayed
--     release rather than resolving an audience that is still moving —
--     docs/ensemble/calendar.html flushes it immediately by calling
--     publish_event() once its own writes have landed.
--
-- Also here: organizations.storage_quota_bytes moves to 5 GiB, the number
-- the Trial card in docs/ensemble/core.js PLANS has always advertised.
--
-- Depends on: 0005 (organizations), 0006 (posts, post_targets, prefs,
-- should_notify), 0007 (org_events, org_event_targets, can_manage_event),
-- 0014 (the queue, enqueue_notification, post_audience).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. a preference the table can actually hold ────────────────────────
-- The in-app bell is a channel a member mutes like any other; 0014 asked
-- should_notify() about it a migration before the column could store it.
-- docs/ensemble/core.js already offers the row and folds it away when the
-- database refuses the value — after this it stops refusing.
alter table public.org_notification_prefs
  drop constraint if exists org_notification_prefs_channel_check;
alter table public.org_notification_prefs
  add constraint org_notification_prefs_channel_check
  check (channel in ('inapp', 'push', 'email'));

comment on column public.org_notification_prefs.channel is
  'inapp | push | email. Widened from (push, email) in 0019 so the in-app '
  'bell can be muted like any other channel — every enqueue path asks '
  'should_notify(member, ''org'', org_id, channel, priority).';

-- ── 2. the release ledger ──────────────────────────────────────────────
-- One row per post/event whose notification has been approved, with the
-- moment it becomes due. Nothing is enqueued from an INSERT any more; this
-- is the only thing that says "this may now go out".
create table if not exists public.notification_releases (
  subject_kind text not null check (subject_kind in ('post', 'event')),
  subject_id uuid not null,
  org_id uuid not null references public.organizations(id) on delete cascade,
  release_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (subject_kind, subject_id)
);
create index if not exists notification_releases_due
  on public.notification_releases (release_at) where released_at is null;

alter table public.notification_releases enable row level security;

comment on table public.notification_releases is
  'Service-role only by design: RLS is on with no policies, so no client can read or write it. One row per post/event cleared for notification, with the moment it becomes due — release_due_notifications() resolves the audience then, never at INSERT time.';

-- ── 3. audience → queue, resolved at release time ──────────────────────
-- Both of these read the row fresh instead of trusting a trigger's NEW, so
-- a post whose targets, priority or ack requirement changed between the
-- write and the release is fanned out as it stands now.
create or replace function public.enqueue_post_notifications(p_post uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  p record;
  m uuid;
  pay jsonb;
  n int := 0;
begin
  select id, org_id, author_member_id, title, priority, requires_ack, archived, publish_at
    into p from public.posts where id = p_post;
  if not found then return 0; end if;
  if p.requires_ack is not true or p.archived is true then return 0; end if;
  if p.publish_at > now() then return 0; end if;   -- not published yet

  pay := jsonb_build_object('post_id', p.id, 'title', left(coalesce(p.title, 'Announcement'), 140));
  for m in select member_id from public.post_audience(p.id) loop
    if m = p.author_member_id then continue; end if;   -- not your own post
    if public.should_notify(m, 'org', p.org_id, 'inapp', p.priority) then
      perform public.enqueue_notification(p.org_id, m, null, 'ack_post', 'inapp',
        p.priority, pay, 'ack:' || p.id || ':' || m, now());
      n := n + 1;
    end if;
    if public.should_notify(m, 'org', p.org_id, 'push', p.priority) then
      perform public.enqueue_notification(p.org_id, m, null, 'ack_post', 'push',
        p.priority, pay, 'ack:' || p.id || ':' || m, now());
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.enqueue_post_notifications(uuid)
  from public, anon, authenticated;

-- Event targeting is group-based (org_event_targets.group_id); no targets
-- means the whole org — same rule as 0014, applied at the right moment.
create or replace function public.enqueue_event_notifications(p_event uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  e record;
  m uuid;
  pay jsonb;
  n int := 0;
begin
  select id, org_id, title, starts_at, rsvp_required
    into e from public.org_events where id = p_event;
  if not found then return 0; end if;
  if e.rsvp_required is not true then return 0; end if;

  pay := jsonb_build_object('event_id', e.id, 'title', left(coalesce(e.title, 'Event'), 140),
                            'starts_at', e.starts_at);
  for m in
    select mm.id from public.org_members mm
     where mm.org_id = e.org_id and mm.status = 'active'
       and (
         not exists (select 1 from public.org_event_targets et where et.event_id = e.id)
         or exists (select 1 from public.org_event_targets et
                     join public.org_group_members gm on gm.group_id = et.group_id
                    where et.event_id = e.id and gm.member_id = mm.id))
  loop
    if public.should_notify(m, 'org', e.org_id, 'inapp', 'normal') then
      perform public.enqueue_notification(e.org_id, m, null, 'rsvp', 'inapp',
        'normal', pay, 'rsvp:' || e.id || ':' || m, now());
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.enqueue_event_notifications(uuid)
  from public, anon, authenticated;

-- ── 4. register a release, and drain what is due ───────────────────────
-- Re-registering re-arms the row on purpose: the dedupe index on
-- org_notifications collapses anyone already told, so republishing after
-- widening the audience reaches the people who were just added and nobody
-- twice.
create or replace function public.register_notification_release(
  p_kind text, p_subject uuid, p_org uuid, p_when timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notification_releases (subject_kind, subject_id, org_id, release_at)
  values (p_kind, p_subject, p_org, coalesce(p_when, now()))
  on conflict (subject_kind, subject_id) do update
     set release_at = excluded.release_at, released_at = null;
end $$;
revoke execute on function public.register_notification_release(text, uuid, uuid, timestamptz)
  from public, anon, authenticated;

create or replace function public.release_due_notifications()
returns int language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select subject_kind, subject_id from public.notification_releases
     where released_at is null and release_at <= now()
     order by release_at
     for update skip locked
  loop
    if r.subject_kind = 'post' then
      perform public.enqueue_post_notifications(r.subject_id);
    else
      perform public.enqueue_event_notifications(r.subject_id);
    end if;
    update public.notification_releases set released_at = now()
     where subject_kind = r.subject_kind and subject_id = r.subject_id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.release_due_notifications()
  from public, anon, authenticated;
grant execute on function public.release_due_notifications() to service_role;

-- ── 5. the client-facing publication step ──────────────────────────────
-- Called by docs/ensemble/feed.html once the post_targets rows exist. It is
-- idempotent, and it flushes anything else that has come due while it is
-- here — which is what makes a scheduled announcement go out even on a
-- project where pg_cron is unavailable and the worker is idle.
create or replace function public.publish_post(p_post uuid)
returns int language plpgsql security definer set search_path = public as $$
declare p record;
begin
  select id, org_id, publish_at, requires_ack, archived
    into p from public.posts where id = p_post;
  if not found then raise exception 'post_not_found'; end if;
  if not public.can_edit_post(p_post) then raise exception 'not_permitted'; end if;
  if p.requires_ack is not true or p.archived is true then return 0; end if;

  -- a post scheduled for next week becomes due then, not now
  perform public.register_notification_release('post', p.id, p.org_id, p.publish_at);
  perform public.release_due_notifications();
  return (select count(*)::int from public.org_notifications
           where channel = 'inapp' and dedupe_key like 'ack:' || p.id || ':%');
end $$;
revoke execute on function public.publish_post(uuid) from public, anon;
grant execute on function public.publish_post(uuid) to authenticated;

-- Called by docs/ensemble/calendar.html after an edit, whose targets are
-- rewritten in requests of their own (docs/ensemble/ops.js).
create or replace function public.publish_event(p_event uuid)
returns int language plpgsql security definer set search_path = public as $$
declare e record;
begin
  select id, org_id, rsvp_required into e from public.org_events where id = p_event;
  if not found then raise exception 'event_not_found'; end if;
  if not public.can_manage_event(p_event) then raise exception 'not_permitted'; end if;
  if e.rsvp_required is not true then return 0; end if;

  perform public.register_notification_release('event', e.id, e.org_id, now());
  perform public.release_due_notifications();
  return (select count(*)::int from public.org_notifications
           where channel = 'inapp' and dedupe_key like 'rsvp:' || e.id || ':%');
end $$;
revoke execute on function public.publish_event(uuid) from public, anon;
grant execute on function public.publish_event(uuid) to authenticated;

-- ── 6. retire the INSERT-time post trigger ─────────────────────────────
-- Nothing replaces it: a post notifies when it is published, and only then.
drop trigger if exists posts_notify_ack on public.posts;
drop function if exists public.notify_ack_post();

-- ── 7. the event trigger, deferred to COMMIT ───────────────────────────
create or replace function public.notify_rsvp_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.rsvp_required is not true then return new; end if;
  if tg_op = 'UPDATE' and old.rsvp_required is true then return new; end if;

  if tg_op = 'INSERT' then
    -- deferred to COMMIT, so the targets org_event_create() writes in this
    -- same transaction are already visible: the audience is exact
    perform public.enqueue_event_notifications(new.id);
  else
    -- an edit that turns RSVP on rewrites its targets in a SEPARATE request,
    -- so hold the release until they have landed. calendar.html calls
    -- publish_event() the moment they have; otherwise the sweep picks it up.
    perform public.register_notification_release('event', new.id, new.org_id,
                                                 now() + interval '2 minutes');
  end if;
  return new;
end $$;
revoke execute on function public.notify_rsvp_event() from public, anon, authenticated;

drop trigger if exists org_events_notify_rsvp on public.org_events;
create constraint trigger org_events_notify_rsvp
  after insert or update on public.org_events
  deferrable initially deferred
  for each row execute function public.notify_rsvp_event();

-- ── 8. the worker releases before it claims ────────────────────────────
-- Identical to 0014's body but for the first line, so a scheduled
-- announcement is enqueued by whatever polls the queue next. CREATE OR
-- REPLACE keeps the existing grants (revoked from every browser role).
create or replace function public.claim_notifications(p_limit int default 50)
returns setof public.org_notifications language plpgsql security definer set search_path = public as $$
begin
  perform public.release_due_notifications();
  return query
    update public.org_notifications n set attempts = attempts + 1
     where n.id in (
       select id from public.org_notifications
        where status = 'pending' and scheduled_at <= now()
        order by scheduled_at
        for update skip locked
        limit greatest(1, least(p_limit, 200)))
    returning n.*;
end $$;

-- ── 9. the Trial card promises 5 GB; the column handed out 1 GiB ───────
alter table public.organizations
  alter column storage_quota_bytes set default 5368709120;   -- 5 GiB

comment on column public.organizations.storage_quota_bytes is
  '5 GiB by default — the storage the Trial plan advertises in '
  'docs/ensemble/core.js PLANS. 0005 defaulted to 1 GiB, which quietly '
  'undersold every new workspace. There are zero organizations in this '
  'project when 0019 is applied, so no existing workspace is affected; '
  'paid plans set their own quota (0015 padmin_set_plan).';

-- ── 10. schedule the release sweep, where the platform allows ──────────
-- Guarded exactly like 0017's storage block and 0018's tail: this file also
-- rides inside the single-transaction RUN_ALL / RUN_ENSEMBLE bundles, and
-- pg_cron is a hosted-platform privilege a scratch database or a restricted
-- SQL role will not have. Where it fails, releases still happen — every
-- publish_post() call and every claim_notifications() batch drains what is
-- due — this just makes a scheduled announcement punctual to the minute.
do $$
begin
  execute 'create extension if not exists pg_cron';
  perform cron.schedule('cadence-notification-release', '* * * * *',
                        'select public.release_due_notifications()');
  raise notice 'Cadence: notification release sweep scheduled each minute (pg_cron).';
exception
  when others then
    raise notice 'Cadence: could not schedule the notification release with pg_cron (%). Scheduled announcements then go out at the next publish or the next worker batch, both of which call release_due_notifications().', sqlerrm;
end $$;


commit;
